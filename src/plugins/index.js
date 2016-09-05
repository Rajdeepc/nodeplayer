import Express from './express';
import Rest from './rest';

let Plugins = [];
Plugins.push(Express);
Plugins.push(Rest); // NOTE: must be initialized after express

module.exports = Plugins;