import { describe, expect, test } from '@jest/globals';

describe('Simple Test Suite', () => {
  test('basic test', () => {
    expect(1 + 1).toBe(2);
  });
  
  test('string concatenation', () => {
    expect('hello' + ' ' + 'world').toBe('hello world');
  });
});