import { describe, test, expect } from '@jest/globals';
import { getApp } from '../app-loader';
import express from 'express';

describe('App Module', () => {
  test('app should be an Express instance', async () => {
    const app = await getApp();
    expect(app).toBeDefined();
    expect(app).toHaveProperty('use');
    expect(app).toHaveProperty('get');
    expect(app).toHaveProperty('post');
    expect(app).toBeInstanceOf(Object);
  });
});