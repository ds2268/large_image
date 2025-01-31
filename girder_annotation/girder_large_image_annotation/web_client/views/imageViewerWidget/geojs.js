import $ from 'jquery';
import _ from 'underscore';
import Backbone from 'backbone';

import events from '@girder/core/events';
import { wrap } from '@girder/core/utilities/PluginUtils';
import { restRequest } from '@girder/core/rest';

import convertAnnotation from '../../annotations/geojs/convert';

/**
 * Generate a new "random" element id (24 random 16 digits).
 */
function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000)
            .toString(16)
            .substring(1);
    }
    return s4() + s4() + s4() + s4() + s4() + s4();
}

var GeojsImageViewerWidgetExtension = function (viewer) {
    wrap(viewer, 'initialize', function (initialize) {
        var settings = arguments[1];

        this._annotations = {};
        this._featureOpacity = {};
        this._unclampBoundsForOverlay = true;
        this._globalAnnotationOpacity = settings.globalAnnotationOpacity || 1.0;
        this._globalAnnotationFillOpacity = settings.globalAnnotationFillOpacity || 1.0;
        this._highlightFeatureSizeLimit = settings.highlightFeatureSizeLimit || 10000;
        this.listenTo(events, 's:widgetDrawRegion', this.drawRegion);
        this.listenTo(events, 'g:startDrawMode', this.startDrawMode);
        this._hoverEvents = settings.hoverEvents;
        return initialize.apply(this, _.rest(arguments));
    });

    return viewer.extend({
        _postRender: function () {
            // the feature layer is for annotations that are loaded
            this.featureLayer = this.viewer.createLayer('feature', {
                features: ['point', 'line', 'polygon']
            });
            this.setGlobalAnnotationOpacity(this._globalAnnotationOpacity);
            this.setGlobalAnnotationFillOpacity(this._globalAnnotationFillOpacity);
            // the annotation layer is for annotations that are actively drawn
            this.annotationLayer = this.viewer.createLayer('annotation', {
                annotations: ['point', 'line', 'rectangle', 'polygon'],
                showLabels: false
            });
            var geo = window.geo; // this makes the style checker happy
            this.viewer.geoOn(geo.event.pan, () => {
                this.setBounds();
            });
        },

        annotationAPI: _.constant(true),

        /**
         * @returns whether to clamp viewer bounds when image overlays are
         * rendered
         */
        getUnclampBoundsForOverlay: function () {
            return this._unclampBoundsForOverlay;
        },

        /**
         *
         * @param {bool} newValue Set whether to clamp viewer bounds when image
         * overlays are rendered.
         */
        setUnclampBoundsForOverlay: function (newValue) {
            this._unclampBoundsForOverlay = newValue;
        },

        /**
         * Given an image overlay annotation element, compute and return
         * a proj-string representation of its transform specification.
         * @param {object} overlay A image annotation element.
         * @returns a proj-string representing how to overlay should be tranformed.
         */
        _getOverlayTransformProjString: function (overlay) {
            const transformInfo = overlay.transform || {};
            let xOffset = transformInfo.xoffset || 0;
            const yOffset = transformInfo.yoffset || 0;
            const matrix = transformInfo.matrix || [[1, 0], [0, 1]];
            const s11 = matrix[0][0];
            const s12 = matrix[0][1];
            const s21 = matrix[1][0];
            const s22 = matrix[1][1];

            let projString = '+proj=longlat +axis=enu';
            if (xOffset !== 0) {
                // negate x offset so positive values specified in the annotation
                // move overlays to the right
                xOffset = -1 * xOffset;
                projString = projString + ` +xoff=${xOffset}`;
            }
            if (yOffset !== 0) {
                projString = projString + ` +yoff=${yOffset}`;
            }
            if (s11 !== 1 || s12 !== 0 || s21 !== 0 || s22 !== 1) {
                // add affine matrix vals to projection string if not identity matrix
                projString = projString + ` +s11=${1 / s11} +s12=${s12} +s21=${s21} +s22=${1 / s22}`;
            }
            return projString;
        },

        /**
         * @returns The number of currently drawn overlay elements across
         * all annotations.
         */
        _countDrawnImageOverlays: function () {
            let numOverlays = 0;
            _.each(this._annotations, (value, key, obj) => {
                let annotationOverlays = value.overlays || [];
                numOverlays += annotationOverlays.length;
            });
            return numOverlays;
        },

        /**
         * Set additional parameters for pixelmap overlays.
         * @param {object} layerParams An object containing layer parameters. This should already have
         * generic properties for overlay annotations set, such as the URL, opacity, etc.
         * @param {object} pixelmapElement A pixelmap annotation element
         * @returns An object containing parameters needed to create a pixelmap layer.
         */
        _addPixelmapLayerParams(layerParams, pixelmapElement) {
            // For pixelmap overlays, there are additional parameters to set
            layerParams.keepLower = false;
            layerParams.url = layerParams.url + `?encoding=PNG`;
            let pixelmapData = pixelmapElement.values;
            if (pixelmapElement.boundaries) {
                let valuesWithBoundaries = new Array(pixelmapData.length * 2);
                for (let i = 0; i < pixelmapData.length; i++) {
                    valuesWithBoundaries[i * 2] = valuesWithBoundaries[i * 2 + 1] = pixelmapData[i];
                }
                pixelmapData = valuesWithBoundaries;
            }
            layerParams.data = pixelmapData;
            layerParams.style = {
                color: (d, i) => {
                    const categoryMap = pixelmapElement.categories;
                    const boundaries = pixelmapElement.boundaries;
                    if (d < 0 || d > categoryMap.length) {
                        console.warn(`No category found at index ${d} in the category map.`);
                        return 'rgba(0, 0, 0, 0)';
                    }
                    let color;
                    let category = categoryMap[d];
                    if (boundaries) {
                        color = (i % 2 === 0) ? category.fillColor : category.strokeColor;
                    } else {
                        color = category.fillColor;
                    }
                    return color;
                }
            };
            return layerParams;
        },

        /**
         * Generate layer parameters for an image overlay layer
         * @param {object} overlayImageMetadata metadata such as size, tile size, and levels for the overlay image
         * @param {string} overlayImageId ID of a girder image item
         * @param {object} overlay information about the overlay such as opacity
         * @returns layer params for the image overlay layer
         */
        _generateOverlayLayerParams(overlayImageMetadata, overlayImageId, overlay) {
            const geo = window.geo;
            let params = geo.util.pixelCoordinateParams(
                this.viewer.node(), overlayImageMetadata.sizeX, overlayImageMetadata.sizeY, overlayImageMetadata.tileWidth, overlayImageMetadata.tileHeight
            );
            params.layer.useCredentials = true;
            params.layer.url = `api/v1/item/${overlayImageId}/tiles/zxy/{z}/{x}/{y}`;
            if (this._countDrawnImageOverlays() <= 6) {
                params.layer.autoshareRenderer = false;
            } else {
                params.layer.renderer = 'canvas';
            }
            params.layer.opacity = overlay.opacity || 1;
            params.layer.opacity *= this._globalAnnotationOpacity;

            if (this.levels !== overlayImageMetadata.levels) {
                const levelDifference = this.levels - overlayImageMetadata.levels;
                params.layer.url = (x, y, z) => 'api/v1/item/' + overlayImageId + `/tiles/zxy/${z - levelDifference}/${x}/${y}`;
                params.layer.minLevel = levelDifference;
                params.layer.maxLevel += levelDifference;

                params.layer.tilesMaxBounds = (level) => {
                    var scale = Math.pow(2, params.layer.maxLevel - level);
                    return {
                        x: Math.floor(overlayImageMetadata.sizeX / scale),
                        y: Math.floor(overlayImageMetadata.sizeY / scale)
                    };
                };
                params.layer.tilesAtZoom = (level) => {
                    var scale = Math.pow(2, params.layer.maxLevel - level);
                    return {
                        x: Math.ceil(overlayImageMetadata.sizeX / overlayImageMetadata.tileWidth / scale),
                        y: Math.ceil(overlayImageMetadata.sizeY / overlayImageMetadata.tileHeight / scale)
                    };
                };
            }
            if (overlay.type === 'pixelmap') {
                params.layer = this._addPixelmapLayerParams(params.layer, overlay);
            }
            return params.layer;
        },

        /**
         * Render an annotation model on the image.  Currently, this is limited
         * to annotation types that can be (1) directly converted into geojson
         * primitives, OR (2) be represented as heatmaps.
         *
         * Internally, this generates a new feature layer for the annotation
         * that is referenced by the annotation id.  All "elements" contained
         * inside this annotation are drawn in the referenced layer.
         *
         * @param {AnnotationModel} annotation
         * @param {object} [options]
         * @param {boolean} [options.fetch=true] Enable fetching the annotation
         *   from the server, including paging the results.  If false, it is
         *   assumed the elements already exist on the annotation object.  This
         *   is useful for temporarily showing annotations that are not
         *   propagated to the server.
         */
        drawAnnotation: function (annotation, options) {
            if (!this.viewer) {
                return;
            }
            var geo = window.geo;
            options = _.defaults(options || {}, {fetch: true});
            var geojson = annotation.geojson();
            const overlays = annotation.overlays() || [];
            var present = _.has(this._annotations, annotation.id);
            var centroidFeature;
            if (present) {
                _.each(this._annotations[annotation.id].features, (feature, idx) => {
                    if (idx || !annotation._centroids || feature.data().length !== annotation._centroids.data.length) {
                        if (feature._ownLayer) {
                            feature.layer().map().deleteLayer(feature.layer());
                        } else {
                            this.featureLayer.deleteFeature(feature);
                        }
                    } else {
                        centroidFeature = feature;
                    }
                });
                if (this._annotations[annotation.id].overlays) {
                    // Ensure that overlay elements that have been deleted are not rendered on a re-draw
                    _.each(this._annotations[annotation.id].overlays, (overlay) => {
                        const oldOverlayIds = this._annotations[annotation.id].overlays.map((overlay) => overlay.id);
                        const updatedOverlayIds = overlays.map((overlay) => overlay.id);
                        _.each(oldOverlayIds, (id) => {
                            if (!updatedOverlayIds.includes(id)) {
                                const overlayLayer = this.viewer.layers().find((layer) => layer.id() === id);
                                this.viewer.deleteLayer(overlayLayer);
                            }
                        });
                    });
                }
            }
            this._annotations[annotation.id] = {
                features: centroidFeature ? [centroidFeature] : [],
                options: options,
                annotation: annotation,
                overlays: overlays
            };
            if (options.fetch && (!present || annotation.refresh() || annotation._inFetch === 'centroids')) {
                annotation.off('g:fetched', null, this).on('g:fetched', () => {
                    // Trigger an event indicating to the listener that
                    // mouseover states should reset.
                    this.trigger(
                        'g:mouseResetAnnotation',
                        annotation
                    );
                    this.drawAnnotation(annotation);
                }, this);
                this.setBounds({[annotation.id]: this._annotations[annotation.id]});
                if (annotation._inFetch === 'centroids') {
                    return;
                }
            }
            annotation.refresh(false);
            var featureList = this._annotations[annotation.id].features;
            // draw centroids except for otherwise shown values
            if (annotation._centroids && !centroidFeature) {
                let feature = this.featureLayer.createFeature('point');
                featureList.push(feature);
                feature.data(annotation._centroids.data).position((d, i) => ({
                    x: annotation._centroids.centroids.x[i],
                    y: annotation._centroids.centroids.y[i]
                })).style({
                    radius: (d, i) => {
                        let r = annotation._centroids.centroids.r[i];
                        if (!r) {
                            return 8;
                        }
                        // the given value is the diagonal of the bounding box, so
                        // to convert it to a circle radius means it must be
                        // divided by 2 or by 2 * 4/pi.
                        r /= 2.5 * this.viewer.unitsPerPixel(this.viewer.zoom());
                        return r;
                    },
                    stroke: (d, i) => {
                        return !annotation._shownIds || !annotation._shownIds.has(annotation._centroids.centroids.id[i]);
                    },
                    strokeColor: (d, i) => {
                        let s = annotation._centroids.centroids.s[i];
                        return annotation._centroids.props[s].strokeColor;
                    },
                    strokeOpacity: (d, i) => {
                        let s = annotation._centroids.centroids.s[i];
                        return annotation._centroids.props[s].strokeOpacity;
                    },
                    strokeWidth: (d, i) => {
                        let s = annotation._centroids.centroids.s[i];
                        return annotation._centroids.props[s].strokeWidth;
                    },
                    fill: (d, i) => {
                        return !annotation._shownIds || !annotation._shownIds.has(annotation._centroids.centroids.id[i]);
                    },
                    fillColor: (d, i) => {
                        let s = annotation._centroids.centroids.s[i];
                        return annotation._centroids.props[s].fillColor;
                    },
                    fillOpacity: (d, i) => {
                        let s = annotation._centroids.centroids.s[i];
                        return annotation._centroids.props[s].fillOpacity;
                    }
                });
                // bind an event so zoom updates radius
                annotation._centroidLastZoom = undefined;
                feature.geoOn(geo.event.pan, () => {
                    if (this.viewer.zoom() !== annotation._centroidLastZoom) {
                        annotation._centroidLastZoom = this.viewer.zoom();
                        if (feature.verticesPerFeature) {
                            let scale = 2.5 * this.viewer.unitsPerPixel(this.viewer.zoom());
                            let vpf = feature.verticesPerFeature(),
                                count = feature.data().length,
                                radius = new Float32Array(vpf * count);
                            for (var i = 0, j = 0; i < count; i += 1) {
                                let r = annotation._centroids.centroids.r[i];
                                if (r) {
                                    r /= scale;
                                } else {
                                    r = 8;
                                }
                                for (var k = 0; k < vpf; k += 1, j += 1) {
                                    radius[j] = r;
                                }
                            }
                            feature.updateStyleFromArray('radius', radius, true);
                        } else {
                            feature.modified().draw();
                        }
                    }
                });
            }
            // draw overlays
            if (this.getUnclampBoundsForOverlay() && this._annotations[annotation.id].overlays.length > 0) {
                this.viewer.clampBoundsY(false);
                this.viewer.clampBoundsX(false);
            }
            _.each(this._annotations[annotation.id].overlays, (overlay) => {
                const overlayItemId = overlay.girderId;
                restRequest({
                    url: `item/${overlayItemId}/tiles`
                }).done((response) => {
                    // Since overlay layers are created asynchronously, we need to ensure that an attempt
                    // to draw the same overlays happening at roughly the same time does not create
                    // extra layers
                    const conflictingLayers = this.viewer.layers().filter(
                        (layer) => layer.id() === overlay.id);
                    if (conflictingLayers.length > 0) {
                        _.each(conflictingLayers, (layer) => {
                            this.viewer.deleteLayer(layer);
                        });
                    }
                    const params = this._generateOverlayLayerParams(response, overlayItemId, overlay);
                    const layerType = (overlay.type === 'pixelmap') ? 'pixelmap' : 'osm';
                    const overlayLayer = this.viewer.createLayer(layerType, params);
                    const proj = this._getOverlayTransformProjString(overlay);

                    overlayLayer.id(overlay.id);
                    overlayLayer.gcs(proj);
                    this.viewer.scheduleAnimationFrame(this.viewer.draw, true);
                }).fail((response) => {
                    console.error(`There was an error overlaying image with ID ${overlayItemId}`);
                });
            });
            this._featureOpacity[annotation.id] = {};
            geo.createFileReader('jsonReader', {layer: this.featureLayer})
                .read(geojson, (features) => {
                    if (features.length === 0) {
                        features = annotation.non_geojson(this.featureLayer);
                        if (features.length) {
                            this.featureLayer.map().draw();
                        }
                    }
                    _.each(features || [], (feature) => {
                        var events = geo.event.feature;
                        featureList.push(feature);

                        feature.selectionAPI(this._hoverEvents);

                        feature.geoOn(
                            [
                                events.mouseclick,
                                events.mouseoff,
                                events.mouseon,
                                events.mouseover,
                                events.mouseout
                            ],
                            (evt) => this._onMouseFeature(evt)
                        );

                        // store the original opacities for the elements in each feature
                        const data = feature.data();
                        if (annotation._centroids) {
                            annotation._shownIds = new Set(feature.data().map((d) => d.id));
                        }
                        if (data.length <= this._highlightFeatureSizeLimit) {
                            this._featureOpacity[annotation.id][feature.featureType] = feature.data()
                                .map(({id, properties}) => {
                                    return {
                                        id,
                                        fillOpacity: properties.fillOpacity,
                                        strokeOpacity: properties.strokeOpacity
                                    };
                                });
                        }
                    });
                    this._mutateFeaturePropertiesForHighlight(annotation.id, features);
                    if (annotation._centroids && featureList[0]) {
                        if (featureList[0].verticesPerFeature) {
                            this.viewer.scheduleAnimationFrame(() => {
                                let vpf = featureList[0].verticesPerFeature(),
                                    count = featureList[0].data().length,
                                    shown = new Float32Array(vpf * count);
                                for (let i = 0, j = 0; i < count; i += 1) {
                                    let val = annotation._shownIds.has(annotation._centroids.centroids.id[i]) ? 0 : 1;
                                    for (let k = 0; k < vpf; k += 1, j += 1) {
                                        shown[j] = val;
                                    }
                                }
                                featureList[0].updateStyleFromArray({
                                    stroke: shown,
                                    fill: shown
                                }, undefined, true);
                            });
                        } else {
                            featureList[0].modified();
                        }
                    }
                    this.viewer.scheduleAnimationFrame(this.viewer.draw, true);
                });
        },

        /**
         * Highlight the given annotation/element by reducing the opacity of all
         * other elements by 75%.  For performance reasons, features with a large
         * number of elements are not modified.  The limit for this behavior is
         * configurable via the constructor option `highlightFeatureSizeLimit`.
         *
         * Both arguments are optional.  If no element is provided, then all
         * elements in the given annotation are highlighted.  If no annotation
         * is provided, then highlighting state is reset and the original
         * opacities are used for all elements.
         *
         * @param {string?} annotation The id of the annotation to highlight
         * @param {string?} element The id of the element to highlight
         */
        highlightAnnotation: function (annotation, element) {
            this._highlightAnnotation = annotation;
            this._highlightElement = element;
            _.each(this._annotations, (layer, annotationId) => {
                const features = layer.features;
                this._mutateFeaturePropertiesForHighlight(annotationId, features);
            });
            this.viewer.scheduleAnimationFrame(this.viewer.draw);
            return this;
        },

        /**
         * Hide the given annotation/element by settings its opacity to 0.  See
         * highlightAnnotation for caveats.
         *
         * If either argument is not provided, hiding is turned off.
         *
         * @param {string?} annotation The id of the annotation to hide
         * @param {string?} element The id of the element to hide
         */
        hideAnnotation: function (annotation, element) {
            this._hideAnnotation = annotation;
            this._hideElement = element;
            _.each(this._annotations, (layer, annotationId) => {
                const features = layer.features;
                this._mutateFeaturePropertiesForHighlight(annotationId, features);
            });
            this.viewer.scheduleAnimationFrame(this.viewer.draw);
            return this;
        },

        /**
         * Use geojs's `updateStyleFromArray` to modify the opacities of alli
         * elements in a feature.  This method uses the private attributes
         * `_highlightAnntotation` and `_highlightElement` to determine which
         * element to modify.
         */
        _mutateFeaturePropertiesForHighlight: function (annotationId, features) {
            _.each(features, (feature) => {
                const data = this._featureOpacity[annotationId][feature.featureType];
                if (!data) {
                    // skip highlighting code on features with a lot of entities because
                    // this slows down interactivity considerably.
                    return;
                }
                var prop = {
                    datalen: data.length,
                    annotationId: annotationId,
                    fillOpacity: this._globalAnnotationFillOpacity,
                    highlightannot: this._highlightAnnotation,
                    highlightelem: this._highlightElement,
                    hideannot: this._hideAnnotation,
                    hideelem: this._hideElement
                };

                if (_.isMatch(feature._lastFeatureProp, prop)) {
                    return;
                }

                // pre-allocate arrays for performance
                const fillOpacityArray = new Array(data.length);
                const strokeOpacityArray = new Array(data.length);

                for (let i = 0; i < data.length; i += 1) {
                    const id = data[i].id;
                    const fillOpacity = data[i].fillOpacity * this._globalAnnotationFillOpacity;
                    const strokeOpacity = data[i].strokeOpacity;
                    if (this._hideAnnotation && annotationId === this._hideAnnotation && id === this._hideElement) {
                        fillOpacityArray[i] = 0;
                        strokeOpacityArray[i] = 0;
                    } else if (!this._highlightAnnotation ||
                            (!this._highlightElement && annotationId === this._highlightAnnotation) ||
                            this._highlightElement === id) {
                        fillOpacityArray[i] = fillOpacity;
                        strokeOpacityArray[i] = strokeOpacity;
                    } else {
                        fillOpacityArray[i] = fillOpacity * 0.25;
                        strokeOpacityArray[i] = strokeOpacity * 0.25;
                    }
                }

                feature.updateStyleFromArray('fillOpacity', fillOpacityArray);
                feature.updateStyleFromArray('strokeOpacity', strokeOpacityArray);
                feature._lastFeatureProp = prop;
            });
            // Also modify opacity of image overlay layers
            const overlays = this._annotations[annotationId].overlays || null;
            if (overlays) {
                _.each(overlays, (overlay) => {
                    const overlayLayer = this.viewer.layers().find((layer) => layer.id() === overlay.id);
                    if (overlayLayer) {
                        let newOpacity = (overlay.opacity || 1) * this._globalAnnotationOpacity;
                        if (this._highlightAnnotation && annotationId !== this._highlightAnnotation) {
                            newOpacity = newOpacity * 0.25;
                        }
                        overlayLayer.opacity(newOpacity);
                    }
                });
            }
        },

        /**
         * When the image visible bounds change, or an annotation is first created,
         * set the view information for any annotation which requires it.
         *
         * @param {object} [annotations] If set, a dictionary where the keys are
         *      annotation ids and the values are an object which includes the
         *      annotation options and a reference to the annotation.  If not
         *      specified, use `this._annotations` and update the view for all
         *      relevant annotatioins.
         */
        setBounds: function (annotations) {
            var zoom = this.viewer.zoom(),
                bounds = this.viewer.bounds(),
                zoomRange = this.viewer.zoomRange();
            _.each(annotations || this._annotations, (annotation) => {
                if (annotation.options.fetch && annotation.annotation.setView) {
                    annotation.annotation.setView(bounds, zoom, zoomRange.max, undefined, this.sizeX, this.sizeY);
                }
            });
        },

        /**
         * Remove an annotation from the image.  If the annotation is not
         * drawn, this does nothing.
         *
         * @param {AnnotationModel} annotation
         */
        removeAnnotation: function (annotation) {
            annotation.off('g:fetched', null, this);
            // Trigger an event indicating to the listener that
            // mouseover states should reset.
            this.trigger(
                'g:mouseResetAnnotation',
                annotation
            );
            if (_.has(this._annotations, annotation.id)) {
                _.each(this._annotations[annotation.id].features, (feature) => {
                    if (feature._ownLayer) {
                        feature.layer().map().deleteLayer(feature.layer());
                    } else {
                        this.featureLayer.deleteFeature(feature);
                    }
                });
                _.each(this._annotations[annotation.id].overlays, (overlay) => {
                    // Use filter instead of find to protect against multiple layers
                    // for the same overlay element.
                    const overlayLayers = this.viewer.layers().filter(
                        (layer) => layer.id() === overlay.id);
                    _.each(overlayLayers, (layer) => {
                        this.viewer.deleteLayer(layer);
                    });
                });
                delete this._annotations[annotation.id];
                delete this._featureOpacity[annotation.id];

                // If removing an overlay annotation results in no more overlays drawn, and we've
                // previously un-clamped bounds for overlays, re-clamp bounds
                if (this._countDrawnImageOverlays() === 0 && this.getUnclampBoundsForOverlay()) {
                    this.viewer.clampBoundsY(true);
                    this.viewer.clampBoundsX(true);
                }
                this.viewer.scheduleAnimationFrame(this.viewer.draw);
            }
        },

        /**
         * Set the image interaction mode to region drawing mode.  This
         * method takes an optional `model` argument where the region will
         * be stored when created by the user.  In any case, this method
         * returns a promise that resolves to an array defining the region:
         *   [ left, top, width, height ]
         *
         * @param {Backbone.Model} [model] A model to set the region to
         * @returns {$.Promise}
         */
        drawRegion: function (model) {
            model = model || new Backbone.Model();
            return this.startDrawMode('polygon', {trigger: false}).then((elements) => {
                /*
                 * Strictly speaking, the rectangle drawn here could be rotated, but
                 * for simplicity we will set the region model assuming it is not.
                 * To be more precise, we could expand the region to contain the
                 * whole rotated rectangle.  A better solution would be to add
                 * a draw parameter to geojs that draws a rectangle aligned with
                 * the image coordinates.
                 */

                model.set('value', elements[0].points, {trigger: true});

                return model.get('value');
            });
        },

        /**
         * Set the image interaction mode to draw the given type of annotation.
         *
         * @param {string} type An annotation type, or null to turn off drawing.
         * @param {object} [options]
         * @param {boolean} [options.trigger=true]
         *      Trigger a global event after creating each annotation element.
         * @returns {$.Promise}
         *      Resolves to an array of generated annotation elements.
         */
        startDrawMode: function (type, options) {
            var layer = this.annotationLayer;
            var elements = [];
            var annotations = [];
            var defer = $.Deferred();
            var element;

            layer.mode(null);
            layer.geoOff(window.geo.event.annotation.state);
            layer.removeAllAnnotations();

            options = _.defaults(options || {}, {trigger: true});
            layer.geoOn(
                window.geo.event.annotation.state,
                (evt) => {
                    if (evt.annotation.state() !== window.geo.annotation.state.done) {
                        return;
                    }
                    element = convertAnnotation(evt.annotation);
                    if (!element.id) {
                        element.id = guid();
                    }
                    elements.push(element);
                    annotations.push(evt.annotation);

                    if (options.trigger) {
                        events.trigger('g:annotationCreated', element, evt.annotation);
                    }

                    layer.removeAllAnnotations();
                    layer.geoOff(window.geo.event.annotation.state);
                    defer.resolve(elements, annotations);
                }
            );
            layer.mode(type);
            return defer.promise();
        },

        setGlobalAnnotationOpacity: function (opacity) {
            this._globalAnnotationOpacity = opacity;
            if (this.featureLayer) {
                this.featureLayer.opacity(opacity);
            }
            Object.values(this._annotations).forEach((annot) => annot.features.forEach((feature) => {
                if (feature._ownLayer) {
                    feature.layer().opacity(opacity);
                }
            }));
            _.each(this._annotations, (annotation) => {
                _.each(annotation.overlays, (overlay) => {
                    const overlayLayer = this.viewer.layers().find((layer) => layer.id() === overlay.id);
                    if (overlayLayer) {
                        const overlayOpacity = overlay.opacity || 1;
                        overlayLayer.opacity(opacity * overlayOpacity);
                    }
                });
            });
            return this;
        },

        setGlobalAnnotationFillOpacity: function (opacity) {
            this._globalAnnotationFillOpacity = opacity;
            if (this.featureLayer) {
                _.each(this._annotations, (layer, annotationId) => {
                    const features = layer.features;
                    this._mutateFeaturePropertiesForHighlight(annotationId, features);
                });
                this.viewer.scheduleAnimationFrame(this.viewer.draw);
            }
            return this;
        },

        _setEventTypes: function () {
            var events = window.geo.event.feature;
            this._eventTypes = {
                [events.mouseclick]: 'g:mouseClickAnnotation',
                [events.mouseoff]: 'g:mouseOffAnnotation',
                [events.mouseon]: 'g:mouseOnAnnotation',
                [events.mouseover]: 'g:mouseOverAnnotation',
                [events.mouseout]: 'g:mouseOutAnnotation'
            };
        },

        _onMouseFeature: function (evt) {
            var properties = evt.data.properties || {};
            var eventType;

            if (!this._eventTypes) {
                this._setEventTypes();
            }

            if (properties.element && properties.annotation) {
                eventType = this._eventTypes[evt.event];

                if (eventType) {
                    this.trigger(
                        eventType,
                        properties.element,
                        properties.annotation,
                        evt
                    );
                }
            }
        }
    });
};

export default GeojsImageViewerWidgetExtension;
