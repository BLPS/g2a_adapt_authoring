// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
const OutputPlugin = require('../../../lib/outputmanager').OutputPlugin;
const util = require('util');

/**
 * Adapt Output plugin
 */
function CourseCdnOutput() {
}
util.inherits(CourseCdnOutput, OutputPlugin);

CourseCdnOutput.prototype.publish = require('./publish');

exports = module.exports = CourseCdnOutput;
