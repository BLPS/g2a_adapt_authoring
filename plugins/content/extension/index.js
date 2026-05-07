// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
/**
 * Extension content plugin
 *
 */
var _ = require('underscore');
var async = require('async');
var bower = require('bower');
var fse = require('fs-extra');
var fs = require('fs');
var path = require('path');
var semver = require('semver');
var util = require('util');

var BowerPlugin = require('../bower');
var database = require('../../../lib/database');
var configuration = require('../../../lib/configuration');
var contentmanager = require('../../../lib/contentmanager');
var helpers = require('../../../lib/helpers');
var logger = require('../../../lib/logger');
var origin = require('../../../');
var rest = require('../../../lib/rest');
var usermanager = require('../../../lib/usermanager');

var ContentPlugin = contentmanager.ContentPlugin;
var ContentTypeError = contentmanager.errors.ContentTypeError;

var defaultOptions = require('./defaults.json');

var bowerConfig = {
  type: 'extensiontype',
  keywords: 'adapt-extension',
  packageType: 'extension',
  srcLocation: 'extensions',
  options: defaultOptions,
  nameList: [],
  updateLegacyContent: function (newPlugin, oldPlugin, next) {
    database.getDatabase(function (err, db) {
      if (err) {
        return next(err);
      }

      // if updating a config, search _enabledExtenions, otherwise, _extensions
      var search = {};
      var targetAttr = '_enabledExtensions.' + oldPlugin.extension;
      search[targetAttr] = { $ne: null };
      db.retrieve('config', search, function (err, docs) {
        // for each content item, update the _extensions array
        async.each(
          docs,
          function (doc, nextItem) {
            // construct the delta
            var enabledExtensions = doc._enabledExtensions;
            Object.keys(enabledExtensions).forEach(function (key) {
              if (enabledExtensions[key]._id.toString() === oldPlugin._id.toString()) {
                enabledExtensions[key]._id = newPlugin._id;
                enabledExtensions[key].version = newPlugin.version;
              }
            });
            // run the update
            db.update('config', { _id: doc._id }, { _enabledExtensions: enabledExtensions }, nextItem);
          }, function (err) {
            if (err) {
              logger.log('error', 'Failed to update old documents: ' + err.message, err);
            }
            return next(null);
          });
      });
    });
  }
};

function Extension () {
  this.bowerConfig = bowerConfig;
}

util.inherits(Extension, BowerPlugin);

/**
 * implements ContentObject#getModelName
 *
 * @return {string}
 */
Extension.prototype.getModelName = function () {
  return 'extension';
};

/**
 *
 * @return {string}
 */
Extension.prototype.getPluginType = function () {
  return 'extensiontype';
};

/**
 * Overrides base.retrieve
 *
 * @param {object} search
 * @param {object} options
 * @param {callback} next
 */
Extension.prototype.retrieve = function (search, options, next) {
  // shuffle params
  if ('function' === typeof options) {
    next = options;
    options = {};
  }

  if (!options.populate) {
    options.populate = { '_extensionType': ['displayName'] };
  }

  ContentPlugin.prototype.retrieve.call(this, search, options, next);
};

/**
 * retrieves an array of extensiontype items that have been enabled on a particular course
 *
 * @param {string} courseId
 * @param {callback} cb
 */
function getEnabledExtensions(courseId, cb) {
  database.getDatabase(function (error, db) {
    if (error) {
      return cb(error);
    }

    // should we delegate this feature to the config plugin?
    db.retrieve('config', { _courseId: courseId }, function (error, results) {
      if (error) {
        return cb(error);
      }

      if (!results || 0 === results.length) {
        logger.log('info', 'could not retrieve config for course ' + courseId);
        return cb(null, []);
      }

      // get the extensions based on the _enabledExtensions attribute
      var extIds = [];
      var enabledExtensions = results[0]._enabledExtensions;
      enabledExtensions && Object.keys(enabledExtensions).forEach(function (key) {
        extIds.push(enabledExtensions[key]._id);
      });
      db.retrieve('extensiontype', { _id: { $in: extIds } }, cb);
    });
  });
}

function contentDeletionHook(contentType, data, cb) {
  var contentData = data[0];

  if (!contentData._id) {
    return cb(null, data);
  }

  // TODO - Check if this is the last component and remove globals?
  return cb(null, data);
}
/**
 * hook to modify a newly created content item based on enabled extensions for a course
 *
 * @param {string} contentType
 * @param {array} data
 * @param {callback} cb
 */
function contentCreationHook (contentType, data, cb) {
  // in creation, data[0] is the content
  var contentData = data[0];
  if (!contentData._courseId) {
    // cannot do anything for unknown courses
    return cb(null, data);
  }

  // Start the async bit
  async.series([
    function(callback) {
      if (contentType == 'component') {
        // Check that any globals for this component are set
        database.getDatabase(function (error, db) {
          if (error) {
            return callback(error);
          }

          db.retrieve('componenttype', {component: contentData._component}, function(err, results) {
            if (err) {
              return callback(err);
            }

            if (!results || results.length == 0) {
              return callback('Unexpected number of componentType records');
            }

            var componentType = results[0]._doc;

            if (componentType.globals) {
              // The component has globals.
              database.getDatabase(function(error, tenantDb) {
                // Add the globals to the course.
                tenantDb.retrieve('course', { _id: contentData._courseId }, function(err, results) {
                  if (err) {
                    return callback(err);
                  }

                  var key = '_' + componentType.component;
                  var courseDoc = results[0]._doc;
                  var courseGlobals = courseDoc._globals
                    ? courseDoc._globals
                    : {};

                  // Create the _components global object.
                  if (!courseGlobals._components) {
                    courseGlobals._components = {};
                  }

                  if (!courseGlobals._components[key]) {
                    // The global JSON does not exist for this component so set the defaults.
                    var componentGlobals = {};

                    for (var prop in componentType.globals) {
                      if (componentType.globals.hasOwnProperty(prop)) {
                        componentGlobals[prop] = componentType.globals[prop].default;
                      }
                    }

                    courseGlobals._components[key] = componentGlobals;

                    tenantDb.update('course', { _id: contentData._courseId }, { _globals: courseGlobals }, function(err, doc) {
                      if (err) {
                        return callback(err);
                      } else {
                        return callback(null);
                      }
                    });
                  } else {
                    return callback(null);
                  }
                });
              });
            } else {
              return callback(null)
            }
          });
        }, configuration.getConfig('dbName'));
      } else {
        return callback(null);
      }
    },
    function(callback) {
      getEnabledExtensions(contentData._courseId, function(error, extensions) {
        if (error) {
          // permit content creation to continue, but log error
          logger.log('error', 'could not load extensions: ' + error.message);
          return callback(null);
        }

        // create _extensions if we need it
        if(!contentData._extensions) contentData._extensions = {};
        extensions.forEach(function(extensionItem) {
          if (extensionItem.properties.hasOwnProperty('pluginLocations') && extensionItem.properties.pluginLocations.properties[contentType]) {
            var schema = extensionItem.properties.pluginLocations.properties[contentType].properties; // yeesh
            var generatedObject = helpers.schemaToObject(schema, extensionItem.name, extensionItem.version, contentType);
            // keep any existing values in place
            contentData._extensions = _.defaults(contentData._extensions, generatedObject);
          }
        });

        // assign back to passed args
        data[0] = contentData;
        callback(null);
      });
    }
  ],
  function(err, results) {
    if (err) {
      logger.log('error', err);
      return cb(err);
    }

    return cb(null, data);
  });
}

/**
 * async loop through extensions, add/remove extension JSON from content
 *
 * @params courseId {string}
 * @params action {string}
 * @params extensions {object} [extension IDs]
 * @param {callback} cb
*/

function toggleExtensions (courseId, action, extensions, cb) {
  if (!extensions || 'object' !== typeof extensions) {
    return cb(new Error('Incorrect parameters passed'));
  }

  var user = usermanager.getCurrentUser();

  if (user && user.tenant && user.tenant._id) {
    // Changes to extensions warrants a full course rebuild
    app.emit('rebuildCourse', user.tenant._id, courseId);
  }

  database.getDatabase(function (err, db) {
    if (err) {
      return cb(err);
    }

    // retrieves specified components for the course and either adds or deletes
    // extension properties of the passed extensionItem
    var updateComponentItems = function (tenantDb, componentType, schema, extensionItem, nextComponent) {
      var criteria = 'course' == componentType ? { _id : courseId } : { _courseId : courseId };
      tenantDb.retrieve(componentType, criteria, { fields: '_id _extensions _enabledExtensions' }, function (err, results) {
        if (err) {
          return cb(err);
        }

        var generatedObject = helpers.schemaToObject(schema, extensionItem.name, extensionItem.version, componentType);
        var targetAttribute = extensionItem.targetAttribute;
        // iterate components and update _extensions attribute
        async.each(results, function (component, next) {
          var isConfig = ('config' == componentType);
          var updatedExtensions = component._extensions || {};
          var enabledExtensions = component._enabledExtensions || {};
          if ('enable' == action) {
            // we need to store extra in the config object
            if (isConfig) {
              enabledExtensions[extensionItem.extension] = {
                _id: extensionItem._id,
                name: extensionItem.name,
                version: extensionItem.version,
                targetAttribute: targetAttribute
              };
            }

            if (generatedObject) {
              updatedExtensions = _.extend(updatedExtensions, generatedObject);
            }
          } else {
            // remove from list of enabled extensions in config object
            if (isConfig) {
              delete enabledExtensions[extensionItem.extension];
            }

            generatedObject && (delete updatedExtensions[targetAttribute]);
          }

          // update using delta
          var delta = { _extensions : updatedExtensions };
          if (isConfig) {
            delta._enabledExtensions = enabledExtensions;
          }

          tenantDb.update(componentType, { _id: component._id }, delta, next);
        }, nextComponent);
      });
    };

    db.retrieve('extensiontype', { _id: { $in: extensions } }, function (err, results) {
      if (err) {
        return cb(err);
      }

      // Switch to the tenant database
      database.getDatabase(function(err, tenantDb) {
        if (err) {
          logger.log('error', err);
          return cb(err);
        }

        // Iterate over all the extensions
        async.eachSeries(results, function (extensionItem, nextItem) {
          var locations = extensionItem.properties.pluginLocations.properties;

          // Ensure that the 'config' key always exists, as this is required
          // to presist the list of enabled extensions.
          if (!_.has(locations, 'config')) {
            locations.config = {};
          }

          if (extensionItem.globals) {
            tenantDb.retrieve('course', { _id: courseId }, function (err, results) {
              if (err) {
                return cb(err);
              }

              var courseDoc = results[0]._doc;
              var key = '_' + extensionItem.extension;
              // Extract the global defaults
              var courseGlobals = courseDoc._globals
                ? courseDoc._globals
                : {};

              if (action == 'enable') {
                // Add default value and
                if (!courseGlobals._extensions) {
                  courseGlobals._extensions = {};
                }

                if (!courseGlobals._extensions[key]) {
                  // The global JSON does not exist for this extension so set the defaults
                  var extensionGlobals = {};

                  for (var prop in extensionItem.globals) {
                    if (extensionItem.globals.hasOwnProperty(prop)) {
                      extensionGlobals[prop] = extensionItem.globals[prop].default;
                    }
                  }

                  courseGlobals._extensions[key] = extensionGlobals;
                }
              } else {
                // Remove any references to this extension from _globals
                if (courseGlobals._extensions && courseGlobals._extensions[key]) {
                  delete courseGlobals._extensions[key];
                }
              }

              tenantDb.update('course', { _id: courseId }, { _globals: courseGlobals }, function(err, doc) {
                if (!err) {
                  async.eachSeries(Object.keys(locations), function (key, nextLocation) {
                    updateComponentItems(tenantDb, key, locations[key].properties, extensionItem, nextLocation);
                  }, nextItem);
                }
              });
            });
          } else {
            async.eachSeries(Object.keys(locations), function (key, nextLocation) {
              updateComponentItems(tenantDb, key, locations[key].properties, extensionItem, nextLocation);
            }, nextItem);
          }
        }, function(err) {
          if (err) {
            cb(err);
          } else {
            // The results array should only ever contain one item now, but using a FOR loop just in case.
            for (var i = 0; i < results.length; i++) {
              // Trigger an event to indicate that the extension has been enabled/disabled.
              app.emit(`extension:${action}`, results[0].name, user.tenant._id, courseId, user._id);
            }

            cb();
          }
        });
      });

    });
  }, configuration.getConfig('dbName'));
}

function enableExtensions(courseId, extensions, cb) {
  if(!extensions || 'object' !== typeof extensions) {
    return cb(new Error('Extensions should be an array of ids'));
  }
  toggleExtensions(courseId, 'enable', extensions, function(error, result) {
    if(error) {
      return cb(error);
    }
    cb();
  });
}

function disableExtensions(courseId, extensions, cb) {
  if(!extensions || 'object' !== typeof extensions) {
    return cb(new Error('Extensions should be an array of ids'));
  }
  toggleExtensions(courseId, 'disable', extensions, function(error, result) {
    if(error) {
      return cb(error);
    }
    cb();
  });
}

/**
 * Returns an array of course objects that use the Extension with the passed id
 * @param callback
 * @param id
 */
Extension.prototype.getUses = function (callback, id) {
  database.getDatabase(function (err, db) {
    if (err) {
      return callback(err);
    }

    db.retrieve('extensiontype', { _id: id }, function (err, extensiontypes) {
      if (err) {
        return callback(err);
      }

      if (extensiontypes.length !== 1) {
        return callback(new Error('extensiontype not found'));
      }

      const search = {};
      search["_enabledExtensions." + extensiontypes[0].extension] = { $exists: true };
      db.retrieve('config', search, function (err, configs) {
        if (err) {
          return callback(err);
        }

        //Group all the course ids into an array for a mongo query
        const courseIDs = [];
        for (var i = 0, len = configs.length; i < len; i++) {
          if(!courseIDs.includes(configs[i]._courseId)) {
            courseIDs.push(configs[i]._courseId)      ;
          }
        }

        db.retrieve('course', { _id: {$in: courseIDs} }, callback);
      });
    });
  });
};

// ---------------------------------------------------------------------------
// Dynamic extension frontend serving
// Serves plugin frontend/ files directly from versions/ at runtime.
// No file copying or bundle rebuilds needed after install.
// ---------------------------------------------------------------------------

function getExtensionFrontendSrc(extensionName) {
  var versionBase = path.join(__dirname, 'versions', extensionName);
  if (!fse.existsSync(versionBase)) return null;

  var versionDirs = [];
  try {
    versionDirs = fse.readdirSync(versionBase).filter(function(d) {
      return fse.statSync(path.join(versionBase, d)).isDirectory() && semver.valid(d);
    });
  } catch (e) {
    return null;
  }

  if (!versionDirs.length) return null;

  versionDirs.sort(semver.rcompare);
  var frontendPath = path.join(versionBase, versionDirs[0], extensionName, 'frontend');
  return fse.existsSync(frontendPath) ? frontendPath : null;
}

// Manifest cache keyed by the full frontendDir path so a version upgrade
// (which changes the path) automatically causes a cache miss.
var frontendServeManifestCache = {};

// Returns the serveFiles allowlist from the extension's package.json (source of
// truth), falling back to bower.json for extensions that pre-date package.json.
// Returns null when neither file declares serveFiles (only the .js check applies).
// Entries that are absolute paths, contain traversal sequences, or resolve
// outside frontendDir are rejected with a warning at manifest-read time.
function getExtensionFrontendManifest(extName, frontendDir) {
  if (Object.prototype.hasOwnProperty.call(frontendServeManifestCache, frontendDir)) {
    return frontendServeManifestCache[frontendDir];
  }
  // Both metadata files live one level above the frontend/ directory
  var extDir = path.dirname(frontendDir);
  var result = null;
  var candidates = ['package.json', 'bower.json'];
  for (var i = 0; i < candidates.length; i++) {
    try {
      var meta = JSON.parse(fse.readFileSync(path.join(extDir, candidates[i]), 'utf8'));
      if (Array.isArray(meta.serveFiles)) {
        result = meta.serveFiles;
        break;
      }
    } catch (e) {
      // file missing or invalid — try next candidate
    }
  }

  if (Array.isArray(result)) {
    var resolvedBase = path.resolve(frontendDir);
    result = result.filter(function(entry) {
      if (typeof entry !== 'string' || !entry) return false;
      if (path.isAbsolute(entry)) {
        logger.log('warn', '[extension-frontend] Rejected absolute path in serveFiles "' + entry + '" for ' + extName);
        return false;
      }
      if (entry.split(/[\/\\]/).indexOf('..') !== -1) {
        logger.log('warn', '[extension-frontend] Rejected traversal sequence in serveFiles "' + entry + '" for ' + extName);
        return false;
      }
      var resolved = path.resolve(path.join(frontendDir, entry));
      if (!resolved.startsWith(resolvedBase + path.sep)) {
        logger.log('warn', '[extension-frontend] Rejected out-of-bounds serveFiles "' + entry + '" for ' + extName);
        return false;
      }
      return true;
    });
  }

  frontendServeManifestCache[frontendDir] = result;
  return result;
}

// ---------------------------------------------------------------------------

/**
 * essential setup
 *
 * @api private
 */
function initialize () {
  BowerPlugin.prototype.initialize.call(new Extension(), bowerConfig);

  var app = origin();

  app.on('extensions:enable', enableExtensions);
  app.on('extensions:disable', disableExtensions);

  app.once('serverStarted', function (server) {

    // remove extensions from content collections
    // expects course ID and an array of extension id's
    rest.post('/extension/disable/:courseid', function (req, res, next) {
      disableExtensions(req.params.courseid, req.body.extensions, function(error) {
        if(error) {
          logger.log('error', error);
          return res.status(error instanceof ContentTypeError ? 400 : 500).json({ success: false, message: error });
        }
        res.status(200).json({ success: true });
      });
    });

    // add extensions to content collections
    // expects course ID and an array of extension id's
    rest.post('/extension/enable/:courseid', function (req, res, next) {
      enableExtensions(req.params.courseid, req.body.extensions, function(error) {
        if(error) {
          logger.log('error', error);
          return res.status(error instanceof ContentTypeError ? 400 : 500).json({ success: false, message: error });
        }
        res.status(200).json({ success: true });
      });
    });

    // Dynamically serves extension frontend files and generates the require bundle.
    // bundle.js → define([...]) listing all installed extensions with a frontend/
    // {name}/...  → serves the file directly from versions/{name}/{ver}/{name}/frontend/
    rest.get('/extension-frontends/*', function(req, res, next) {
      var urlPath = req.params[0];

      if (urlPath === 'bundle.js' || urlPath === 'bundle') {
        var versionsBase = path.join(__dirname, 'versions');
        var moduleIds = [];
        if (fse.existsSync(versionsBase)) {
          try {
            var extensions = fse.readdirSync(versionsBase).filter(function(d) {
              return fse.statSync(path.join(versionsBase, d)).isDirectory();
            });
            moduleIds = extensions.filter(function(name) {
              var frontendDir = getExtensionFrontendSrc(name);
              if (!frontendDir) return false;
              var allowedFiles = getExtensionFrontendManifest(name, frontendDir);
              if (allowedFiles !== null && !allowedFiles.includes('index.js')) {
                logger.log('warn', '[extension-frontend] Skipping "' + name + '" from bundle: index.js not in serveFiles');
                return false;
              }
              if (!fse.existsSync(path.join(frontendDir, 'index.js'))) {
                logger.log('warn', '[extension-frontend] Skipping "' + name + '" from bundle: index.js not found on disk');
                return false;
              }
              return true;
            }).map(function(name) {
              return 'extension-frontends/' + name + '/index';
            });
          } catch (e) {
            logger.log('error', '[extension-frontend] Bundle error: ' + e.message);
          }
        }
        var deps = moduleIds.map(function(id) { return '"' + id + '"'; }).join(',');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        return res.send('define([' + deps + '], function() {});');
      }

      var parts = urlPath.split('/');
      var extName = parts[0];
      var filePath = parts.slice(1).join('/');

      // Reject traversal in extName — must be a plain package name with no path chars.
      // %2E%2E is decoded by Express before reaching here, so checking for '..' is sufficient.
      if (!extName || extName === '..' || extName.indexOf('/') !== -1 || extName.indexOf('\\') !== -1 || extName.charAt(0) === '.') {
        return res.status(400).send('Bad Request');
      }
      // Reject traversal sequences in filePath before touching the filesystem.
      if (!filePath || filePath.split('/').indexOf('..') !== -1) {
        return res.status(403).send('Forbidden');
      }

      var frontendDir = getExtensionFrontendSrc(extName);
      if (!frontendDir) return next();
      // Manifest check — allowlist declared in the extension's bower.json serveFiles
      var allowedFiles = getExtensionFrontendManifest(extName, frontendDir);
      if (allowedFiles !== null && !allowedFiles.includes(filePath)) {
        return res.status(403).send('Forbidden');
      }
      var ext = path.extname(filePath).toLowerCase();
      if (ext !== '.js') return res.status(403).send('Forbidden');
      var absolutePath = path.resolve(path.join(frontendDir, filePath));
      if (!absolutePath.startsWith(path.resolve(frontendDir) + path.sep)) {
        return res.status(403).send('Forbidden');
      }
      res.sendFile(absolutePath, function(err) {
        if (!err) return;
        if (err.code === 'ENOENT' || err.status === 404) {
          logger.log('warn', '[extension-frontend] File not found: ' + absolutePath);
          return res.status(404).json({ success: false, message: 'Extension file not found: ' + filePath });
        }
        logger.log('error', '[extension-frontend] Error serving ' + absolutePath + ': ' + err.message);
        return res.status(500).json({ success: false, message: 'Internal server error' });
      });
    });
  });

  // HACK surface this properly somewhere
  app.contentmanager.toggleExtensions = toggleExtensions;

  // add content creation hooks for each viable content type
  ['contentobject', 'article', 'block', 'component'].forEach(function (contentType) {
    app.contentmanager.addContentHook('create', contentType, contentCreationHook.bind(null, contentType));
  });

  ['component'].forEach(function(contentType) {
    app.contentmanager.addContentHook('destroy', contentType, contentDeletionHook.bind(null, contentType));
  });
}

// setup extensions
initialize();

/**
 * Module exports
 *
 */

exports = module.exports = Extension;
