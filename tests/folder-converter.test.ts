import test from 'node:test';
import assert from 'node:assert/strict';

import { convertFolder } from '../src/messaging/converters/folder.ts';

test('convertFolder keeps folder placeholders without exposing downloadable file resources', () => {
  const result = convertFolder(
    JSON.stringify({
      file_key: 'file_v3_01100_b5a280c5-d69a-4b5b-bfd7-1c0d116824bg',
      file_name: 'hr-analysis',
    }),
    {} as never,
  );

  assert.equal(result.content, '<folder key="file_v3_01100_b5a280c5-d69a-4b5b-bfd7-1c0d116824bg" name="hr-analysis"/>');
  assert.deepEqual(result.resources, []);
});
