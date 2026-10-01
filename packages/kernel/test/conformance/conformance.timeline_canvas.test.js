'use strict';
const { defineScenarioTests, SHARDS } = require('./define');

defineScenarioTests((id) => SHARDS.timeline_canvas.includes(id));
