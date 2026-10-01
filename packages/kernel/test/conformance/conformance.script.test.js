'use strict';
const { defineScenarioTests, SHARDS } = require('./define');

defineScenarioTests((id) => SHARDS.script.includes(id));
