import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error publish-kit is a JavaScript workspace package
import { sanitizePublish } from "@jansee/publish-kit";

describe("PublishKit title separation & anti-fallback", () => {
  it("never wipes out cover_title even for image-film mode and keeps publish title distinct from plan title", () => {
    const raw = {
      title: "人间有光", // 模型偷懒，和设计卡短标题一致
      cover_title: "",   // 留空
      caption: "记录一些相信奇迹的瞬间。日子普通，但光会来。#人生感悟 #生活碎片",
      pinned_comment: "你最近遇到的那个「小奇迹」是什么？",
      post_time: "晚间 19:30-21:30 黄金流量档",
    };

    const sanitized = sanitizePublish(raw, {
      scene: "personal",
      title: "人间有光", // 视觉设计卡 4 字标题
      subtitle: "日常有光 万物可期",
      coverTitleRequired: true,
    });

    assert.ok(sanitized.title, "publish.title 必须存在");
    assert.notEqual(sanitized.title, "人间有光", "publish.title 严禁写成4字设计卡短标题");
    assert.ok(sanitized.title.length >= 8, "publish.title 长度应符合社媒吸睛标准(≥8字)");

    assert.ok(sanitized.cover_title, "publish.cover_title 严禁被抹空");
    assert.notEqual(sanitized.cover_title, "人间有光", "publish.cover_title 严禁退化为4字视觉短标题");
    assert.ok(sanitized.cover_title.length >= 8, "publish.cover_title 长度应≥8字");

    assert.equal(sanitized.caption, raw.caption);
    assert.equal(sanitized.pinned_comment, raw.pinned_comment);
    assert.equal(sanitized.post_time, raw.post_time);
  });

  it("preserves authentic high quality social media title when provided by LLM", () => {
    const raw = {
      title: "打工人宵夜救星！2块钱一包的光友酸辣粉丝",
      cover_title: "2块钱一包的酸辣粉丝！打工人深夜必囤",
      caption: "加班深夜来一碗，酸辣过瘾。#打工人深夜食堂",
      pinned_comment: "你们夜宵最爱吃哪款速食？",
      post_time: "晚间 21:00-23:00",
    };

    const sanitized = sanitizePublish(raw, {
      scene: "sell",
      title: "光友粉丝",
      subtitle: "酸辣浓郁 劲道爽滑",
      coverTitleRequired: true,
    });

    assert.equal(sanitized.title, "打工人宵夜救星！2块钱一包的光友酸辣粉丝");
    assert.equal(sanitized.cover_title, "2块钱一包的酸辣粉丝！打工人深夜必囤");
  });
});
