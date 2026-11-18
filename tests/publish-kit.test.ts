import test from 'node:test';
import assert from 'node:assert/strict';
import { filterBannedWords, sanitizePublish } from '@jansee/publish-kit';
test('removes high-risk absolute claims', () => { const r=filterBannedWords('全网最好，100%有效，绝对放心'); assert.ok(r.hits.length >= 2); assert.doesNotMatch(r.text,/全网最好|100%|绝对/); });
test('supplies safe fallback fields', () => { const r=sanitizePublish(null,{scene:'local',title:'咖啡店',subtitle:'日常分享'}); assert.ok(r.caption.length>0); assert.ok(r.cover_title.length>0); assert.ok(r.caption.length<=300); });
test('suppresses duplicate image-film cover title', () => { const r=sanitizePublish({caption:'记录日常',cover_title:'重复标题'},{scene:'personal',coverTitleRequired:false}); assert.equal(r.cover_title,''); assert.equal(r.caption,'记录日常'); });
test('bounds public fields and replaces stale years', () => { const r=sanitizePublish({caption:'2024年新品体验',cover_title:'日常记录',pinned_comment:'欢迎交流'.repeat(30),post_time:'周末'},{scene:'personal'}); assert.match(r.caption,/现在/); assert.ok(r.pinned_comment.length<=60); assert.equal(r.post_time,'周末'); });
