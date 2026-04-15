import crypto from 'node:crypto'
import got from 'got'

// ---------------------------------------------------------------------------
// Digest Auth helpers
// ---------------------------------------------------------------------------

function md5 (str) {
  return crypto.createHash('md5').update(str).digest('hex')
}

/**
 * Parse the key="value" pairs out of a WWW-Authenticate: Digest header.
 * @param {string} header
 * @returns {object}
 */
function parseDigestChallenge (header) {
  const params = {}
  // Match both quoted and unquoted values (qop / algorithm are often unquoted).
  const re = /(\w+)=(?:"([^"]*)"|([\w-]+))/g
  let m
  while ((m = re.exec(header)) !== null) {
    params[m[1]] = m[2] ?? m[3]
  }
  return params
}

/**
 * Build an Authorization: Digest header for a GET request.
 * Supports qop=auth and the legacy qop-less form.
 *
 * @param {string} uri       Path + query string of the request URL.
 * @param {string} username
 * @param {string} password
 * @param {object} challenge Parsed digest challenge parameters.
 * @returns {string}
 */
function buildDigestAuth (uri, username, password, challenge) {
  const { realm, nonce, qop, opaque, algorithm } = challenge

  // Only MD5 / MD5-sess are common on IP cameras. Treat absent as MD5.
  const algo = (algorithm ?? 'MD5').toUpperCase()
  let ha1 = md5(`${username}:${realm}:${password}`)
  if (algo === 'MD5-SESS') {
    const cnonce = crypto.randomBytes(8).toString('hex')
    ha1 = md5(`${ha1}:${nonce}:${cnonce}`)
  }
  const ha2 = md5(`GET:${uri}`)

  let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}"`

  if (
    qop &&
    qop
      .split(',')
      .map((s) => s.trim())
      .includes('auth')
  ) {
    const nc = '00000001'
    const cnonce = crypto.randomBytes(8).toString('hex')
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    authHeader += `, qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`
  } else {
    // Legacy — no qop
    const response = md5(`${ha1}:${nonce}:${ha2}`)
    authHeader += `, response="${response}"`
  }

  if (algorithm) authHeader += `, algorithm=${algorithm}`
  if (opaque) authHeader += `, opaque="${opaque}"`

  return authHeader
}

// ---------------------------------------------------------------------------

/**
 * Capture a JPEG snapshot from an IP camera using HTTP Digest Authentication.
 * Issues an unauthenticated probe request first, then responds to the 401
 * challenge with the computed Digest credentials.
 *
 * @param {object} cameraConfig
 * @param {string} cameraConfig.url        Full snapshot URL (e.g. http://ip/cgi-bin/snapshot.cgi?channel=1)
 * @param {string} cameraConfig.username   Digest Auth username
 * @param {string} cameraConfig.password   Digest Auth password
 * @param {number} [cameraConfig.timeoutMs=5000]  Request timeout in milliseconds
 * @param {object} [gotFn=got]  got-compatible HTTP client (injectable for tests)
 * @returns {Promise<{data: Buffer, contentType: string}>}
 */
export async function capturePhoto (cameraConfig, gotFn = got) {
  const { url, username, password, timeoutMs = 5000 } = cameraConfig
  const opts = {
    responseType: 'buffer',
    timeout: { request: timeoutMs },
    throwHttpErrors: false
  }

  // Step 1: probe — camera replies with 401 + Digest challenge.
  const probe = await gotFn(url, opts)

  if (probe.statusCode >= 200 && probe.statusCode < 300) {
    // Camera has auth disabled — return the image directly.
    return {
      data: probe.body,
      contentType: probe.headers['content-type'] ?? 'image/jpeg'
    }
  }

  if (probe.statusCode !== 401) {
    throw new Error(`Camera responded with HTTP ${probe.statusCode}`)
  }

  const wwwAuth = probe.headers['www-authenticate'] ?? ''
  if (!wwwAuth.toLowerCase().startsWith('digest')) {
    throw new Error(
      `Expected Digest challenge, got WWW-Authenticate: ${wwwAuth}`
    )
  }

  const challenge = parseDigestChallenge(wwwAuth)
  const { pathname, search } = new URL(url)
  const uri = pathname + search

  // Step 2: authenticated request.
  const response = await gotFn(url, {
    ...opts,
    throwHttpErrors: true,
    headers: {
      Authorization: buildDigestAuth(uri, username, password, challenge)
    }
  })

  return {
    data: response.body,
    contentType: response.headers['content-type'] ?? 'image/jpeg'
  }
}

/**
 * Create a serial capture queue that ensures only one camera snapshot request
 * runs at a time. Rapid tag scans enqueue captures here rather than firing
 * concurrent HTTP requests at the camera.
 *
 * @returns {{ enqueue: (fn: () => Promise<void>) => void }}
 */
export function createCaptureQueue () {
  let tail = Promise.resolve()

  return {
    enqueue (fn) {
      tail = tail.then(fn).catch(() => {
        // Errors are handled and logged inside fn; swallow here to keep the
        // chain alive for subsequent captures.
      })
    }
  }
}
