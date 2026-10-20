/**
 * What the alert voice is handed, before any synthesiser sees it.
 *
 * A ready alert reads the same sentence the toast shows — "ข้าวเกรียบ พร้อมเสิร์ฟ
 * — โต๊ะ 9" — so the voice follows the tenant's language with no second string to
 * translate. Two things have to hold for that to come out right: the em dash the
 * written sentence uses as a separator must not reach the synthesiser, since some
 * voices pronounce it, and each run has to go to a voice that can pronounce its
 * script, because no installed voice reads both Thai and Latin.
 */
import assert from 'node:assert/strict';
import { pickVoice, speakableText, splitByScript } from '../frontend/src/lib/speech';

function voice(lang: string): any {
  return { lang, name: `voice-${lang}`, default: false, localService: true, voiceURI: lang };
}

function main() {
  console.log('Alert speech');
  console.log('='.repeat(32));

  // --- the written separator must not be spoken ---
  assert.equal(
    speakableText('ข้าวเกรียบ พร้อมเสิร์ฟ — โต๊ะ 9'),
    'ข้าวเกรียบ พร้อมเสิร์ฟ, โต๊ะ 9',
    'an em dash becomes the comma the voice already pauses on',
  );
  assert.equal(speakableText('Latte is ready – Table 4'), 'Latte is ready, Table 4');
  assert.equal(speakableText('  spaced  '), 'spaced', 'surrounding space is trimmed');
  console.log('  ✓ the separator is replaced, not pronounced');

  // --- each script run goes out whole ---
  const mixed = splitByScript('โต๊ะ 9, ICE Amerigano 2, ต้มยำ 1');
  assert.deepEqual(
    mixed.map((segment) => segment.thai),
    [true, false, true],
    'runs alternate by script',
  );
  assert.ok(mixed[0].text.includes('9'), 'digits stay with the run they follow');
  assert.ok(mixed[1].text.includes('ICE Amerigano'), 'the Latin run is kept whole');
  assert.equal(
    mixed
      .map((segment) => segment.text)
      .join('')
      .replace(/[\s,]/g, ''),
    'โต๊ะ9ICEAmerigano2ต้มยำ1',
    'nothing is dropped and nothing is reordered',
  );
  console.log('  ✓ mixed scripts split into whole runs');

  assert.deepEqual(splitByScript(' , — '), [], 'punctuation alone has nothing to pronounce');
  assert.deepEqual(splitByScript(''), [], 'empty text produces no runs');
  console.log('  ✓ nothing to say produces no utterance');

  // --- voice selection ---
  const installed = [voice('en-US'), voice('th-TH'), voice('de-DE')];
  assert.equal(pickVoice(installed, ['th-TH', 'th'])?.lang, 'th-TH', 'an exact tag wins');
  assert.equal(
    pickVoice([voice('th_TH')], ['th-TH'])?.lang,
    'th_TH',
    'an underscore tag is the same tag',
  );
  assert.equal(
    pickVoice(installed, ['en-GB'])?.lang,
    'en-US',
    'a missing region falls back within the language',
  );
  assert.equal(
    pickVoice(installed, ['ja-JP', 'en-US'])?.lang,
    'en-US',
    'preference order is respected',
  );
  assert.equal(pickVoice([], ['th-TH']), null, 'no voices means no choice');
  assert.equal(pickVoice(installed, ['ja-JP']), null, 'an absent language is not substituted');
  console.log('  ✓ voices are matched by tag, then language, then not at all');

  console.log('\nAll alert speech assertions passed.');
}

main();
