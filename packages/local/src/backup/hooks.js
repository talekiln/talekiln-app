// Hook called before destructive operations (regenerate storyboard, quality rerun, delete).
// Default is a no-op; backup/localSnapshot wires itself in via setBeforeDestructive().
let handler = null

function setBeforeDestructive(fn) {
  handler = typeof fn === 'function' ? fn : null
}

async function beforeDestructive(episodeId, reason) {
  if (!handler) return null
  try {
    return await handler(episodeId, reason)
  } catch (err) {
    // A failed safety snapshot must never block the user's action.
    return null
  }
}

module.exports = { beforeDestructive, setBeforeDestructive }
