/* globals beforeEach, afterEach, describe, it, expect, _ */

girderTest.importPlugin('large_image');

girderTest.startApp();

$(function () {
    describe('setup', function () {
        it('mock Webgl', function () {
            var girder = window.girder;
            var GeojsViewer = girder.plugins.large_image.views.imageViewerWidget.geojs;
            girder.utilities.PluginUtils.wrap(GeojsViewer, 'initialize', function (initialize) {
                this.once('g:beforeFirstRender', function () {
                    window.geo.util.mockWebglRenderer();
                });
                initialize.apply(this, _.rest(arguments));
            });
        });
        it('create the admin user', function () {
            girderTest.createUser(
                'admin', 'admin@email.com', 'Admin', 'Admin', 'testpassword')();
        });
    });
    describe('test accessing a multi-frame image', function () {
        it('go to users page', girderTest.goToUsersPage());

        it('Got to a user page and then the Public folder', function () {
            runs(function () {
                $('a.g-user-link').trigger('click');
            });
            waitsFor(function () {
                return $('button:contains("Actions")').length === 1;
            }, 'user page to appear');
            waitsFor(function () {
                return $('a.g-folder-list-link:contains(Public):visible').length === 1;
            }, 'the Public folder to be clickable');
            runs(function () {
                $('a.g-folder-list-link:contains(Public)').trigger('click');
            });
            waitsFor(function () {
                return $('.g-folder-actions-button:visible').length === 1;
            }, 'the folder to appear');
        });
        it('upload test file', function () {
            girderTest.waitForLoad();
            runs(function () {
                $('.g-folder-list-link:first').click();
            });
            girderTest.waitForLoad();
            runs(function () {
                girderTest.binaryUpload('${large_image}/../../test/test_files/multi_test_source3.yml');
            });
            girderTest.waitForLoad();
        });
        it('navigate to item and wait for an image', function () {
            runs(function () {
                $('a.g-item-list-link').click();
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return $('.g-item-image-viewer-select').length !== 0;
            }, 'image to load', 15000);
        });
        it('adjust frame slider', function () {
            runs(function () {
                expect($('.image-controls-frame').length).toBe(1);
                $('.image-controls-number').val(1).trigger('input');
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return $('.image-controls-slider').val() === '1';
            }, 'control slider to update');
        });
    });
    describe('upload test file', function () {
        it('go to collections page', function () {
            runs(function () {
                $("a.g-nav-link[g-target='collections']").click();
            });

            waitsFor(function () {
                return $('.g-collection-create-button:visible').length > 0;
            }, 'navigate to collections page');

            runs(function () {
                expect($('.g-collection-list-entry').length).toBe(0);
            });
        });
        it('create collection', girderTest.createCollection('test', '', 'image'));
        it('upload test file', function () {
            girderTest.waitForLoad();
            runs(function () {
                $('.g-folder-list-link:first').click();
            });
            girderTest.waitForLoad();
            runs(function () {
                girderTest.binaryUpload('${large_image}/../../test/test_files/yb10kx5k.png');
            });
            girderTest.waitForLoad();
        });
        it('navigate to item and make a large image', function () {
            runs(function () {
                $('a.g-item-list-link').click();
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return $('.g-large-image-create').length !== 0;
            });
            runs(function () {
                $('.g-large-image-create').click();
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return $('.g-item-image-viewer-select').length !== 0;
            }, 'job to complete', 15000);
            girderTest.waitForLoad();
        });
    });

    describe('removal', function () {
        it('unmake a large image', function () {
            runs(function () {
                $('.g-large-image-remove').click();
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return !$('.g-item-image-viewer-select').length;
            }, 'select button to vanish', 15000);
            girderTest.waitForLoad();
        });
        it('remake a large image and then remove the image file', function () {
            waitsFor(function () {
                return $('.g-large-image-create').length > 0;
            }, 'make large image button to appear');
            runs(function () {
                $('.g-large-image-create').click();
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return $('.g-item-image-viewer-select').length !== 0;
            }, 'job to complete', 15000);
            girderTest.waitForLoad();
            runs(function () {
                $('.g-delete-file').click();
            });
            girderTest.waitForDialog();
            runs(function () {
                $('#g-confirm-button').click();
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return !$('.g-item-image-viewer-select').length;
            }, 'select button to vanish', 15000);
            girderTest.waitForLoad();
        });
        it('upload test file', function () {
            girderTest.waitForLoad();
            runs(function () {
                $('.g-item-breadcrumb-link[data-type="folder"]:last').click();
            });
            girderTest.waitForLoad();
            runs(function () {
                girderTest.binaryUpload('${large_image}/../../test/test_files/yb10kx5k.png');
            });
            girderTest.waitForLoad();
        });
        it('navigate to item and make a large image', function () {
            waitsFor(function () {
                return $('a.g-item-list-link').length > 0;
            }, 'link to appear');
            runs(function () {
                $('a.g-item-list-link').click();
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return $('.g-large-image-create').length !== 0;
            });
            runs(function () {
                $('.g-large-image-create').click();
            });
            girderTest.waitForLoad();
            waitsFor(function () {
                return $('.g-item-image-viewer-select').length > 0 && $('.g-large-image-remove').length > 0;
            }, 'job to complete', 15000);
            girderTest.waitForLoad();
        });
    });

    describe('Image Viewer selection', function () {
        var viewers = [], jQuery; // use the original jQuery
        it('One viewer is loaded', function () {
            waitsFor(function () {
                return $('.image-viewer').not('.hidden').not(':empty').length !== 0;
            }, 'one viewer to be shown');
            runs(function () {
                expect($('.image-viewer').not('.hidden').length).toBe(1);
                var selected = $('.g-item-image-viewer-select .g-item-info-header select').val();
                expect($('.image-viewer').not('.hidden').attr('id')).toBe(selected);
                $('.g-item-image-viewer-select .g-item-info-header select option').each(function () {
                    viewers.push($(this).val());
                });
                expect(viewers.length).toBe(5);
                jQuery = $;
            }, 'get list of viewers');
        });
        it('Select each viewer in turn via change, then return to geojs', function () {
            viewers.push('geojs');
            _.each(viewers, function (vid, idx) {
                runs(function () {
                    var $ = jQuery;
                    $('.g-item-image-viewer-select .g-item-info-header select').val(vid).change();
                }, 'select ' + vid + ' (' + idx + ')');
                waitsFor(function () {
                    var $ = jQuery;
                    return !$('.image-viewer:empty').not('.hidden').length &&
                           !$('.image-viewer.hidden').not(':empty').length &&
                           $('.image-viewer').not('.hidden').not(':empty').length &&
                           $('.image-viewer').not('.hidden').length === 1 &&
                           $('.image-viewer').not('.hidden').attr('id') === vid;
                }, 'wait for ' + vid + ' (' + idx + ') to be visible');
                runs(function () {
                    var $ = jQuery;
                    expect($('.image-viewer').not('.hidden').length).toBe(1);
                }, 'check ' + vid + ' (' + idx + ')');
            });
        });
    });
});
