'use strict';
const { defineScenarioTests, SHARDS } = require('./define');

defineScenarioTests((id) => SHARDS.shots.includes(id));
