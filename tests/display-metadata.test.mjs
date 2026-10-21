import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'

/**
 * The DSH Plugin Manager reads display text and artwork without loading the
 * plugin: it resolves `<package>/locale/<lang>.json`, `<package>/icon`, and
 * `<package>/package.json` through the Node module resolver, so anything the
 * `exports` map omits is invisible no matter what the files on disk say.
 * These assertions pin the four resources that surface the title, the
 * one-line description, and the card icon.
 */
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('display resources are exported for the Plugin Manager resolver', () => {
  for (const specifier of ['./package.json', './icon', './locale/en.json', './locale/zh.json']) {
    assert.ok(
      Object.keys(manifest.exports).includes(specifier)
        || (specifier.startsWith('./locale/') && './locale/*.json' in manifest.exports),
      `exports must expose ${specifier}`,
    )
  }
  assert.equal(manifest.exports['.'], './lib/index.mjs', 'the plugin entry stays the first export')
})

test('every locale file carries non-empty meta text', () => {
  const languages = ['en', 'zh']
  for (const language of languages) {
    const file = new URL(`../locale/${language}.json`, import.meta.url)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof parsed.meta?.title, 'string', `${language}: meta.title`)
    assert.ok(parsed.meta.title.trim() !== '', `${language}: meta.title must not be blank`)
    assert.equal(typeof parsed.meta?.description, 'string', `${language}: meta.description`)
    assert.ok(parsed.meta.description.trim() !== '', `${language}: meta.description must not be blank`)
  }
})

test('the icon is an in-package SVG below the 256 KiB ceiling', () => {
  assert.equal(manifest.icon, undefined, 'an exported ./icon is used when no manifest icon is declared')
  const icon = new URL('../icon.svg', import.meta.url)
  const stat = statSync(icon)
  assert.ok(stat.isFile(), 'icon.svg must be a regular file')
  assert.ok(stat.size <= 256 * 1024, `icon.svg is ${stat.size} bytes, over the 256 KiB ceiling`)
  assert.match(readFileSync(icon, 'utf8'), /<svg[\s>]/, 'icon.svg must be SVG markup')
})

test('the packed file list keeps every display resource', () => {
  for (const entry of ['locale/*.json', 'icon.svg']) {
    assert.ok(manifest.files.includes(entry), `files must keep ${entry}`)
  }
})

test('the resolver finds the display resources from this package root', () => {
  for (const specifier of [
    'dsh-popup-notify/package.json',
    'dsh-popup-notify/icon',
    'dsh-popup-notify/locale/en.json',
    'dsh-popup-notify/locale/zh.json',
  ]) {
    assert.doesNotThrow(() => require.resolve(specifier), `${specifier} must resolve`)
  }
})
