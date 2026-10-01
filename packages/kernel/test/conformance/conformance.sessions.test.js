'use strict';
const { defineScenarioTests, SHARDS } = require('./define');

defineScenarioTests((id) => SHARDS.sessions.includes(id));
