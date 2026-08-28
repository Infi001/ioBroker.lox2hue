const path = require('path');
const { tests } = require('@iobroker/testing');

// Prueft package.json/io-package.json auf Konsistenz (Name, Version, Pflichtfelder usw.)
tests.packageFiles(path.join(__dirname, '..'));
