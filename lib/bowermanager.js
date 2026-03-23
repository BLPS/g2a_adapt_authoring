var _ = require('underscore');
var async = require('async');
var bower = require('bower');
var fs = require('fs-extra');
var path = require('path');
var semver = require('semver');

var configuration = require('./configuration');
var installHelpers = require('./installHelpers');
var Constants = require('./outputmanager').Constants;
var database = require('./database');
var logger = require('./logger');
var origin = require('./application')();

var bowerOptions = require('../plugins/content/bower/defaults.json');

/*
 * CONSTANTS
 */
var MODNAME = 'bowermanager',
  WAITFOR = 'contentmanager';

var BowerManager = function() {

}

BowerManager.prototype.extractPackageInfo = function(plugin, pkgMeta, schema) {
  // Build package info.
  var info = {
    name: pkgMeta.name,
    displayName: pkgMeta.displayName,
    description: pkgMeta.description,
    version: pkgMeta.version,
    framework: pkgMeta.framework ? pkgMeta.framework : null,
    homepage: pkgMeta.homepage ? pkgMeta.homepage : null,
    issues: pkgMeta.issues ? pkgMeta.issues : null,
    isLocalPackage: pkgMeta.isLocalPackage ? pkgMeta.isLocalPackage : false,
    properties: schema.properties,
    globals: schema.globals ? schema.globals : null
  };

  // The targetAttribute property is optional.
  if (pkgMeta.targetAttribute) {
    info.targetAttribute = pkgMeta.targetAttribute;
  }

  // The assetFields property is optional too.
  if (pkgMeta.assetFields) {
    info.assetFields = pkgMeta.assetFields;
  }

  // Set the type and package id for the package.
  info[plugin.getModelName()] = pkgMeta[plugin.getModelName()];

  // Set extra properties.
  plugin.extra && plugin.extra.forEach(function (key) {
    if (pkgMeta[key]) {
      info[key] = pkgMeta[key];
    }
  });

  return info;
}

/**
 * Installs a specified Adapt plugin.
 * @param {string} pluginName - The name of the Adapt plugin
 * @param {string} pluginVersion - The semantic version or branch name to install, for latest use '*'
 * @param {function} callback - Callback function
 * @param {string|null} pluginSource - Git URL
 */
BowerManager.prototype.installPlugin = function(pluginName, pluginVersion, callback, pluginSource) {
  var self = this;

  var gitUrl = pluginSource ?? null;

  var installTarget = gitUrl ? gitUrl : pluginName;
  var installName = pluginName;
  if (pluginVersion && pluginVersion !== '*') {
    installTarget += '#' + pluginVersion;
    installName += '#' + pluginVersion;
  }

  // Clear the bower cache for this plugin.
  fs.remove(path.join(bowerOptions.directory, pluginName), function (err) {
    if (err) {
      logger.log('error', err);
      return callback(err);
    }

    var performInstall = function() {
      bower.commands.install([installTarget], { save: true }, bowerOptions)
        .on('error', function(err) {
          logger.log('error', err);
          return callback(err);
        })
        .on('end', function (packageInfo) {
          // Bower returns an object. Usually the key is the name from the plugin's bower.json
          var installedPackage = packageInfo[pluginName];

          // Fallback: if bower saved it under a different key (can happen with direct Git URLs)
          if (!installedPackage) {
            var keys = Object.keys(packageInfo);
            if (keys.length > 0) {
              installedPackage = packageInfo[keys[0]];
            } else {
              return callback('Installation failed: package info not found.');
            }
          }

          var pkgMeta = installedPackage.pkgMeta;

          // Unfortunately this is required as the only way to identify the type
          // of a plugin is to check for the presence of the property which
          // actually indicates its type. :-/
          var pluginType = pkgMeta.hasOwnProperty('component') ? 'component'
            : pkgMeta.hasOwnProperty('extension') ? 'extension'
              : pkgMeta.hasOwnProperty('menu') ? 'menu'
                : pkgMeta.hasOwnProperty('theme') ? 'theme' : '';

          if (pluginType == '') {
            logger.log('error', 'Unable to identify pluginType for ' + installName);
            return callback('Unable to identify pluginType for ' + installName);
          }

          app.contentmanager.getContentPlugin(pluginType, function(err, plugin) {
            if (err) return callback(err);

            installHelpers.getInstalledFrameworkVersion(function(error, frameworkVersion) {
              if (error) return callback(error);

              if (!pkgMeta.framework) {
                return self.importPackage(plugin, installedPackage, bowerOptions, callback);
              }

              // If the plugin defines a framework, ensure that it is compatible
              if (!semver.satisfies(semver.clean(frameworkVersion), pkgMeta.framework)) {
                var fwError = `Unable to install ${pkgMeta.name} (${pkgMeta.framework}) as it is not supported in the current version of the Adapt framework (${frameworkVersion})`;
                logger.log('error', fwError);
                return callback(fwError);
              }

              self.importPackage(plugin, installedPackage, bowerOptions, callback);
            });
          });
        });
    };

    if (gitUrl) {
      // If it's a direct Git URL, BYPASS the registry search and install immediately
      performInstall();
    } else {
      // If it's a standard plugin, check the Bower registry first (original logic)
      bower.commands.search(pluginName, bowerOptions)
        .on('error', callback)
        .on('end', function (results) {
          if (!results || results.length == 0) {
            logger.log('warn', 'Plugin ' + installName + ' not found!');
            return callback('Plugin ' + installName + ' not found!');
          }
          // The plugin exists in the registry -- proceed with installation
          performInstall();
        });
    }
  });
};

/**
 * Wrapper for installPlugin which install the latest version that's compatible
 * with the installed framework.
 * @param {string} pluginName - The name of the Adapt plugin
 * @param {function} callback - Callback function
 */
BowerManager.prototype.installLatestCompatibleVersion = function (pluginName, callback) {
  var self = this;
  // Query bower to verify that the specified plugin exists.
  bower.commands.search(pluginName, bowerOptions)
    .on('error', callback)
    .on('end', function (results) {
      if (!results || results.length == 0) {
        logger.log('warn', 'Plugin ' + pluginName + ' not found!');
        return callback('Plugin ' + pluginName + ' not found!');
      }
      // The plugin exists -- remove any fuzzy matches
      var bowerPackage = _.findWhere(results, {name: pluginName});

      self._processPluginVersions(pluginName, bowerPackage.url, callback);
    });
};

/**
 * Wrapper for _processPluginVersions which installs a plugin directly from a specified Git URL,
 * bypassing the Bower registry search, while ensuring framework compatibility.
 * @param {string} pluginName - The name of the Adapt plugin
 * @param {string} gitUrl - The direct Git repository URL of the plugin
 * @param {function} callback - Callback function
 */
BowerManager.prototype.installFromGitUrl = function (pluginName, gitUrl, callback) {
  let finalUrl = gitUrl;
  const token = configuration.getConfig('gitToken');

  if (token) {
    finalUrl = finalUrl.replace('${GIT_TOKEN}', token).replace('GIT_TOKEN', token);
  } else {
    if (finalUrl.includes('GIT_TOKEN')) {
      logger.log('warn', 'GIT_TOKEN found in URL for ' + pluginName + ', but no gitToken found in config.json!');
    }
  }

  this._processPluginVersions(pluginName, finalUrl, callback);
};

/**
 * Core logic to verify compatibility and install the latest compatible version
 * of a plugin from a given package URL (registry or Git repository).
 * If the source is a direct Git URL, it formats the install target to bypass
 * the Bower registry (e.g., "pluginName=gitUrl").
 * @param {string} pluginName - The name of the Adapt plugin
 * @param {string} packageUrl - The URL of the package to query versions from
 * @param {function} callback - Callback function
 */
BowerManager.prototype._processPluginVersions = function (pluginName, packageUrl, callback) {
  var self = this;

  bower.commands.info(packageUrl)
    .on('error', callback)
    .on('end', function (latestInfo) {
      installHelpers.getInstalledFrameworkVersion(function(error, installedFrameworkVersion) {
        if(error) return callback(error);

        var requiredFrameworkVersion;
        var index = -1;
        var pluginType;

        async.doUntil(function iterator(cb) {
          bower.commands.info(packageUrl + '#' + latestInfo.versions[++index])
            .on('error', cb)
            .on('end', function (result) {
              requiredFrameworkVersion = result.framework;
              pluginType = Object.keys(result).find(key => {
                return [ 'component', 'extension', 'menu', 'theme' ].includes(key);
              });
              cb();
            });
        }, async function isCompatible() {
          return semver.satisfies(installedFrameworkVersion, requiredFrameworkVersion);
        }, error => {
          if(error) return callback(error);
          const isGitUrl = latestInfo && latestInfo.name.startsWith("git+")

          app.contentmanager.getContentPlugin(pluginType, (error, plugin) => {
            if (error) return callback(error);

            app.db.retrieve(plugin.getPluginType(), { name: pluginName }, (error, results) => {
              if (error) return callback(error);

              var installedPlugin = results[0];
              var version = latestInfo.versions[index];
              if (installedPlugin &&
                semver.gte(installedPlugin.version, version) &&
                semver.satisfies(installedFrameworkVersion, installedPlugin.framework)) {
                return callback('Skipping as no newer compatible version found');
              }

              if (isGitUrl) {
                self.installPlugin(pluginName, version, callback, packageUrl);
              } else {
                self.installPlugin(pluginName, version, callback, null);
              }
            });
          });
        });
      });
    });
};

/**
 * adds a new package to the system - fired after bower
 * has installed to the cache
 *
 * @param {object} plugin - bowerConfig object for a bower plugin type
 * @param {object} packageInfo - the bower package info retrieved during install
 * @param {object} options
 * @param {callback} callback
 */
BowerManager.prototype.importPackage = function (plugin, packageInfo, options, callback) {
  // Shuffle params.
  if ('function' === typeof options) {
    callback = options;
    options = {
      strict: false
    };
  }

  var self = this;
  var pkgMeta = packageInfo.pkgMeta;
  var schemaPath = path.join(packageInfo.canonicalDir, options._adaptSchemaFile);

  fs.exists(schemaPath, function (exists) {
    if (!exists) {
      if (options.strict) {
        return callback('Package does not contain a schema');
      }

      logger.log('warn', 'ignoring package with no schema: ' + pkgMeta.name);
      return callback(null);
    }

    fs.readFile(schemaPath, function (err, data) {
      var schema = false;
      if (err) {
        if (options.strict) {
          return callback('Failed to parse schema for package ' + pkgMeta.name);
        }

        logger.log('error', 'failed to parse schema for ' + pkgMeta.name, err);
        return callback(null);
      }

      try {
        schema = JSON.parse(data);
      } catch (e) {
        if (options.strict) {
          return callback('Failed to parse schema for package ' + pkgMeta.name);
        }

        logger.log('error', 'failed to parse schema for ' + pkgMeta.name, e);
        return callback(null);
      }

      // use the passed dest, or build a path to the destination working folder
      var destination = path.join(app.configuration.getConfig('root').toString(), 'temp', app.configuration.getConfig('masterTenantID'), 'adapt_framework', 'src', plugin.bowerConfig.srcLocation, pkgMeta.name);

      // Remove whatever version of the plugin is there already.
      fs.remove(destination, function(err) {
        if (err) {
          return logger.log('error', err);
        }

        // Re-create the plugin folder.
        fs.mkdirs(destination, function (err) {
          if (err) {
            return logger.log('error', err);
          }

          // Move from the bower cache to the working directory.
          fs.copy(packageInfo.canonicalDir, destination, function (err) {
            if (err) {
              // Don't double call callback.
              return logger.log('error', err);
            }

            logger.log('info', 'Successfully copied ' + pkgMeta.name + ' to ' + destination);

            // Build the package information.
            var package = self.extractPackageInfo(plugin, pkgMeta, schema);
            var db = app.db;
            var pluginString = package.name + ' (v' + package.version + ')';

            // Add the package to the collection.
            // Check if a plugin with this name and version already exists.
            db.retrieve(plugin.getPluginType(), {
              name: package.name
            }, function (err, results) {
              if (err) {
                logger.log('error', err);
                return callback(err);
              }

              if (results && results.length !== 0) {
                var installedPlugin = results[0];

                if (installedPlugin.version === package.version) {
                  // Don't add a duplicate.
                  if (options.strict) {
                    return callback("Can't add " + pluginString + ": verion already exists");
                  }

                  return callback(null);
                }

                var keysToPersist = [ '_isAvailableInEditor', '_isAddedByDefault' ];

                keysToPersist.forEach(key => package[key] = installedPlugin[key]);
              }

              // Add the new plugin.
              db.create(plugin.getPluginType(), package, function (err, newPlugin) {
                if (err) {
                  logger.log('error', err);

                  if (options.strict) {
                    return callback(err);
                  }

                  logger.log('error', 'Failed to add package: ' + pluginString, err);
                  return callback(null);
                }

                logger.log('info', 'Added package: ' + pluginString);

                // Retrieve any older versions of the plugin.
                db.retrieve(plugin.getPluginType(), { name: package.name, version: { $ne: newPlugin.version } }, function (err, results) {
                  if (err) {
                    // strictness doesn't matter at this point
                    logger.log('error', 'Failed to retrieve previous packages: ' + err.message, err);
                  }

                  // Remove older versions of this plugin.
                  db.destroy(plugin.getPluginType(), { name: package.name, version: { $ne: newPlugin.version } }, function (err) {
                    if (err) {
                      logger.log('error', err);
                      return callback(err);
                    }

                    logger.log('info', 'Successfully removed versions of ' + package.name + ' (' + plugin.getPluginType() + ') older than ' + newPlugin.version);

                    return callback(null, newPlugin);
                  }); // Remove older versions of the plugin.
                }); // Retrieve older versions of the plugin.
              }); // Add the new plugin.
            }); // Check if a plugin with this name and version already exists.
          });
        });
      });
    });
  });
}

exports = module.exports = {

  // expose the bower manager constructor
  BowerManager : BowerManager,

  /**
   * preload function
   *
   * @param {object} app - the Origin instance
   * @return {object} preloader - a ModulePreloader
   */
  preload : function (app) {
    var preloader = new app.ModulePreloader(app, MODNAME, { events: this.preloadHandle(app, new BowerManager()) });
    return preloader;
  },

  /**
   * Event handler for preload events
   *
   * @param {object} app - Server instance
   * @param {object} instance - Instance of this module
   * @return {object} hash map of events and handlers
   */
  preloadHandle : function (app, instance){

    return {
      preload : function(){
        var preloader = this;
        preloader.emit('preloadChange', MODNAME, app.preloadConstants.WAITING);
      },

      moduleLoaded : function(modloaded){
        var preloader = this;

        //is the module that loaded this modules requirement
        if (modloaded === WAITFOR) {
          app.bowermanager = instance;
          preloader.emit('preloadChange', MODNAME, app.preloadConstants.COMPLETE);
        }
      }
    };
  }
};
