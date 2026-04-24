export function buildAuthorizeUrl (tagauthorizeHost, tag, mac, antenna) {
  const query = new URLSearchParams({
    mac,
    antenna: String(antenna)
  })
  return `${tagauthorizeHost}/tags/${encodeURIComponent(tag)}/authorize.json?${query.toString()}`
}

export function authorizationCacheKey (mac, tag) {
  return `__garage_authorizer__/authorizing/${mac}/${tag}`
}

export function resolveAuthorizationAction (response, doorConfig) {
  if (response === 'authorized') {
    return doorConfig ? 'open_door' : 'misconfigured'
  }
  if (response === 'record_only') return 'record_only'
  return 'deny'
}
