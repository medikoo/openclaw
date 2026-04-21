#!/usr/bin/env node

"use strict";

require("essentials");
require("log-node")();

const tagName = process.argv[2];

if (!tagName) {
  log.error("Usage: node upgrade.js <tag-name>");
  process.exit(1);
}

require("../upgrade")(tagName);
