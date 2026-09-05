import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * This repository is readable by people who are not the operator, so a client
 * name committed here is a disclosure that no amount of later private-repo
 * hygiene takes back. Fixtures therefore name a fictional client, and this test
 * is what keeps that true — a convention documented in the README and enforced
 * nowhere is a convention that lasts until the next person is in a hurry.
 *
 * The check is deliberately shaped so it cannot itself leak: it does not carry
 * a list of real client slugs to compare against. It asserts the positive
 * instead — every client repo reference must be the fixture one — which catches
 * any real slug without ever naming one.
 */

const ROOT = join(__dirname, '..', '..', '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'coverage'])
const SCAN_EXT = /\.(ts|tsx|js|jsx|md|json|yml|yaml)$/
const FIXTURE_SLUG = 'example-client'

/** `owner/clients-<slug>` references, the shape a client zone repo takes. */
const CLIENT_REPO = /[A-Za-z0-9][\w.-]*\/clients-([\w.-]+)/g
/** `z1-<slug>` zone identifiers. */
const CLIENT_ZONE = /\bz1-([\w.-]+)/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SCAN_EXT.test(name)) out.push(full)
  }
  return out
}

describe('no real client identifiers in a publicly readable repo', () => {
  const files = walk(ROOT)

  it('scans a non-trivial number of files', () => {
    // Guards the guard: a walk that silently matched nothing would make every
    // assertion below vacuously true, which is the classic way a check like
    // this rots into decoration.
    expect(files.length).toBeGreaterThan(20)
  })

  it('references only the fixture client repo', () => {
    const found: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const [, slug] of text.matchAll(CLIENT_REPO)) {
        if (slug !== FIXTURE_SLUG) found.push(`${relative(ROOT, file)}: clients-${slug}`)
      }
    }
    expect(found).toEqual([])
  })

  it('references only the fixture client zone', () => {
    const found: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const [, slug] of text.matchAll(CLIENT_ZONE)) {
        if (slug !== FIXTURE_SLUG) found.push(`${relative(ROOT, file)}: z1-${slug}`)
      }
    }
    expect(found).toEqual([])
  })

  it('uses only reserved or first-party domains in email addresses', () => {
    // RFC 2606 reserves example.com/net/org and the .example TLD precisely so
    // fixtures never point at a real mailbox. An outside address here is either
    // a privacy leak or a test that could one day mail a stranger.
    //
    // First-party addresses are allowed and necessary: the OIDC tests assert
    // that the operator's own domain is admitted and everything else refused,
    // and they cannot express that without naming it. The distinction this
    // enforces is between our own identity, which is already public on the
    // company site, and someone else's, which is not ours to publish.
    const email = /[\w.+-]+@([\w-]+\.[\w.-]+)/g
    const allowed =
      /(^|\.)(example\.(com|net|org)|example|localhost|invalid|test|metzgercreative\.com|builderz\.dev)$/i
    const found: string[] = []
    for (const file of files) {
      if (!file.includes('__tests__') && !file.endsWith('.md')) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        // A URL or a connection string (`mongodb+srv://user:pw@host/db`) has an
        // `@` that is not an address; matching one would make the credential
        // scanner's own fixtures look like leaked mail.
        if (line.includes('://')) continue
        for (const [match, raw] of line.matchAll(email)) {
          const domain = raw.replace(/\.+$/, '')
          // `claude-code@1.2.3` is a version specifier, not an address. A real
          // domain's last label is alphabetic; a package version's is not.
          const tld = domain.split('.').pop() ?? ''
          if (!/^[A-Za-z]{2,}$/.test(tld)) continue
          if (!allowed.test(domain)) found.push(`${relative(ROOT, file)}: ${match}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
