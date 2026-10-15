import test from 'node:test';
import assert from 'node:assert/strict';
import { appPage } from '../src/app-pages.mjs';

test('публичные страницы приложения связаны с политикой и отзывом доступа', () => {
  assert.match(appPage('/youtube-app/'), /href="\/youtube-app\/privacy\/"/);
  assert.match(appPage('/youtube-app/privacy/'), /security.google.com\/settings\/security\/permissions/);
  assert.match(appPage('/youtube-app/privacy/'), /7 календарных дней/);
  assert.match(appPage('/youtube-app/terms/'), /youtube.com\/t\/terms/);
});

test('публичная выдача ограничена точными адресами', () => {
  assert.equal(appPage('/youtube-app/../../.env'), null);
  assert.equal(appPage('/youtube-app/unknown/'), null);
});
