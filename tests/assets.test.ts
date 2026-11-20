import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerAssetRoutes, cleanupExpiredAssets, isImageMetadataWithinLimits, resolveUploadConcurrencyLimit, type AssetRecord, type AssetStore } from "../apps/api/src/assets.js";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.js";
import type { LocalObjectStorage } from "../apps/api/src/storage-local.js";

const origin="https://jansee.example";
const token="a".repeat(43);
const user:AuthUser={id:"user-123",email:"creator@example.com",displayName:"Creator",createdAt:new Date()};
function stores() {
 const auth:AuthStore={
  async createUser(){return user;},async findUserByEmail(){return null;},
  async createSession(){},async findSession(hash){return hash===createHash("sha256").update(token).digest("hex")?{user,expiresAt:new Date(Date.now()+60_000)}:null;},
  async revokeSession(){},
 };
 const saved=new Map<string,Buffer>(); const paths=new Map<string,string>(); let inserted:AssetRecord[]=[];
 const storageDir=join(tmpdir(),`jansee-v4-asset-preview-test-${process.pid}`);
 const storage:LocalObjectStorage={
  async putFile(key,path){
   const bytes=await readFile(path); saved.set(key,bytes);
   await mkdir(storageDir,{recursive:true});
   const target=join(storageDir,key.replace(/[^a-zA-Z0-9_-]/g,"_"));
   await writeFile(target,bytes); paths.set(key,target);
   return {sizeBytes:bytes.length};
  },
  async getFilePath(key){const path=paths.get(key);if(!path)throw new Error("not found");return path;},
  async deleteObject(key){saved.delete(key);paths.delete(key);},
  async deleteExpired(){return 0;},
 };
 const assetStore:AssetStore={
   async createAssets(_userId,assets){inserted=[...inserted,...assets];},
   async findUserAssets(userId,ids){return userId===user.id?inserted.filter(a=>ids.includes(a.id)):[];},
   async listUserAssets(userId){return userId===user.id?inserted:[];},
   async deleteAsset(userId,assetId){
     if(userId!==user.id) return null;
     const index=inserted.findIndex(a=>a.id===assetId);
     if(index===-1) return null;
     const rec=inserted[index]!;
     inserted.splice(index,1);
     return {storageKey:rec.storageKey};
   },
   async findExpiredAssets(){return inserted.map(a=>({id:a.id,userId:user.id,storageKey:a.storageKey}));},
   async markAssetsExpired(ids){inserted=inserted.filter(a=>!ids.includes(a.id));},
 };
 return {auth,storage,assetStore,saved,get inserted(){return inserted;}};
}
function multipart(file:Buffer,filename="sample.png",mime="image/png") {
 const boundary="----jansee-v4-test-boundary";
 const head=Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\"files\"; filename=\""+filename+"\"\r\nContent-Type: "+mime+"\r\n\r\n");
 const tail=Buffer.from("\r\n--"+boundary+"--\r\n");
 return {boundary,payload:Buffer.concat([head,file,tail])};
}
function pngHeader(){return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nKkAAAAASUVORK5CYII=","base64");}

test("upload concurrency is bounded for the 4-core production host and invalid settings fail safely", () => {
 assert.equal(resolveUploadConcurrencyLimit(undefined), 2);
 assert.equal(resolveUploadConcurrencyLimit("1"), 1);
 assert.equal(resolveUploadConcurrencyLimit("4"), 4);
 assert.equal(resolveUploadConcurrencyLimit("10"), 4);
 assert.equal(resolveUploadConcurrencyLimit("0"), 1);
 assert.equal(resolveUploadConcurrencyLimit("-5"), 1);
 assert.equal(resolveUploadConcurrencyLimit("invalid"), 2);
});

test("image metadata limits reject decompression bombs and excessive dimensions", () => {
 assert.equal(isImageMetadataWithinLimits({width: 1, height: 1}), true);
 assert.equal(isImageMetadataWithinLimits({width: 12001, height: 1}), false);
 assert.equal(isImageMetadataWithinLimits({width: 8000, height: 6000}), false);
 assert.equal(isImageMetadataWithinLimits({width: 1000, height: 1000, pages: 101}), false);
 assert.equal(isImageMetadataWithinLimits({width: 5000, pageHeight: 2000, pages: 5}), false);
 assert.equal(isImageMetadataWithinLimits({width: 0, height: 10}), false);
});

test("asset upload requires an authenticated session",async()=>{
 const s=stores(),app=Fastify();
 registerAssetRoutes(app,{authStore:s.auth,assetStore:s.assetStore,storage:s.storage,allowedOrigins:[origin]});
 try { const form=multipart(pngHeader()); const response=await app.inject({method:"POST",url:"/api/v1/assets",headers:{origin,"content-type":"multipart/form-data; boundary="+form.boundary},payload:form.payload}); assert.equal(response.statusCode,401); }
 finally {await app.close();}
});

test("authenticated upload validates file signature, stores privately and records owner-bound asset metadata",async()=>{
 const s=stores(),app=Fastify();
 registerAssetRoutes(app,{authStore:s.auth,assetStore:s.assetStore,storage:s.storage,allowedOrigins:[origin],production:false});
 try {
  const form=multipart(pngHeader(),"../../product.png","application/octet-stream");
  const response=await app.inject({method:"POST",url:"/api/v1/assets",headers:{origin,cookie:"jansee_session="+token,"content-type":"multipart/form-data; boundary="+form.boundary},payload:form.payload});
  assert.equal(response.statusCode,201,response.body);
  const asset=response.json().assets[0];
  assert.equal(asset.mediaType,"image"); assert.equal(asset.mimeType,"image/png"); assert.equal(asset.status,"uploaded");
  assert.equal(s.inserted.length,1); assert.equal(s.inserted[0]!.originalName,"product.png");
  assert.equal(s.inserted[0]!.storageKey,"users/user-123/"+asset.assetId);
  assert.ok(s.inserted[0]!.expiresAt instanceof Date);
  assert.ok(s.inserted[0]!.expiresAt!.getTime() > Date.now());
  assert.equal(s.saved.size,1);
 } finally {await app.close();}
});

test("asset upload rejects truncated image data even when the file signature claims PNG", async () => {
 const s=stores(),app=Fastify();
 registerAssetRoutes(app,{authStore:s.auth,assetStore:s.assetStore,storage:s.storage,allowedOrigins:[origin],production:false});
 try {
  const form=multipart(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),"truncated.png","image/png");
  const response=await app.inject({method:"POST",url:"/api/v1/assets",headers:{origin,cookie:"jansee_session="+token,"content-type":"multipart/form-data; boundary="+form.boundary},payload:form.payload});
  assert.equal(response.statusCode,415);
  assert.equal(response.json().error.code,"INVALID_IMAGE");
  assert.equal(s.saved.size,0);
 } finally { await app.close(); }
});

test("asset upload rejects a file with an unknown signature",async()=>{
 const s=stores(),app=Fastify();
 registerAssetRoutes(app,{authStore:s.auth,assetStore:s.assetStore,storage:s.storage,allowedOrigins:[origin],production:false});
 try {
  const form=multipart(Buffer.from("this is not an image"),"fake.png","image/png");
  const response=await app.inject({method:"POST",url:"/api/v1/assets",headers:{origin,cookie:"jansee_session="+token,"content-type":"multipart/form-data; boundary="+form.boundary},payload:form.payload});
  assert.equal(response.statusCode,415); assert.equal(response.json().error.code,"UNSUPPORTED_FILE"); assert.equal(s.saved.size,0); assert.equal(s.inserted.length,0);
 } finally {await app.close();}
});

test("asset upload rejects untrusted origins",async()=>{
 const s=stores(),app=Fastify();
 registerAssetRoutes(app,{authStore:s.auth,assetStore:s.assetStore,storage:s.storage,allowedOrigins:[origin],production:false});
 try { const form=multipart(pngHeader()); const response=await app.inject({method:"POST",url:"/api/v1/assets",headers:{origin:"https://evil.example",cookie:"jansee_session="+token,"content-type":"multipart/form-data; boundary="+form.boundary},payload:form.payload}); assert.equal(response.statusCode,403); }
 finally {await app.close();}
});

test("storage objects are rolled back when the asset database transaction fails",async()=>{
 const s=stores(),app=Fastify();
 const failingStore:AssetStore={async createAssets(){throw new Error("database unavailable");}};
 registerAssetRoutes(app,{authStore:s.auth,assetStore:failingStore,storage:s.storage,allowedOrigins:[origin]});
 try {
  const form=multipart(pngHeader());
  const response=await app.inject({method:"POST",url:"/api/v1/assets",headers:{origin,cookie:"jansee_session="+token,"content-type":"multipart/form-data; boundary="+form.boundary},payload:form.payload});
  assert.equal(response.statusCode,500,response.body);
  assert.equal(s.saved.size,0);
 } finally {await app.close();}
});

test("authenticated user can list own assets and delete an owned asset", async () => {
  const s = stores(), app = Fastify();
  registerAssetRoutes(app, { authStore: s.auth, assetStore: s.assetStore, storage: s.storage, allowedOrigins: [origin], production: false });
  try {
    const form = multipart(pngHeader(), "photo.png", "image/png");
    const uploadRes = await app.inject({
      method: "POST", url: "/api/v1/assets",
      headers: { origin, cookie: `jansee_session=${token}`, "content-type": `multipart/form-data; boundary=${form.boundary}` },
      payload: form.payload,
    });
    assert.equal(uploadRes.statusCode, 201);
    const assetId = uploadRes.json().assets[0].assetId;
    assert.equal(s.saved.size, 1);

    // 查询列表
    const listRes = await app.inject({
      method: "GET", url: "/api/v1/assets",
      headers: { cookie: `jansee_session=${token}` },
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.headers["cache-control"], "no-store");
    assert.equal(listRes.json().assets.length, 1);
    assert.equal(listRes.json().assets[0].assetId, assetId);

    // 删除该资产
    const deleteRes = await app.inject({
      method: "DELETE", url: `/api/v1/assets/${assetId}`,
      headers: { origin, cookie: `jansee_session=${token}` },
    });
    assert.equal(deleteRes.statusCode, 204);
    assert.equal(s.saved.size, 0); // 物理文件被删除
    assert.equal(s.inserted.length, 0); // 数据库记录已清除

    // 再次删除返回 404
    const deleteAgainRes = await app.inject({
      method: "DELETE", url: `/api/v1/assets/${assetId}`,
      headers: { origin, cookie: `jansee_session=${token}` },
    });
    assert.equal(deleteAgainRes.statusCode, 404);
  } finally { await app.close(); }
});

test("delete rejects invalid asset id format and unauthenticated requests", async () => {
  const s = stores(), app = Fastify();
  registerAssetRoutes(app, { authStore: s.auth, assetStore: s.assetStore, storage: s.storage, allowedOrigins: [origin], production: false });
  try {
    const unauthRes = await app.inject({ method: "DELETE", url: "/api/v1/assets/not-a-uuid" });
    assert.equal(unauthRes.statusCode, 401);

    const badIdRes = await app.inject({
      method: "DELETE", url: "/api/v1/assets/not-a-uuid",
      headers: { origin, cookie: `jansee_session=${token}` },
    });
    assert.equal(badIdRes.statusCode, 400);
  } finally { await app.close(); }
});

test("asset preview serves the owner image privately and rejects anonymous or invalid requests", async () => {
  const s = stores(), app = Fastify();
  registerAssetRoutes(app, { authStore: s.auth, assetStore: s.assetStore, storage: s.storage, allowedOrigins: [origin], production: false });
  try {
    const form = multipart(pngHeader(), "photo.png", "image/png");
    const uploadRes = await app.inject({
      method: "POST", url: "/api/v1/assets",
      headers: { origin, cookie: `jansee_session=${token}`, "content-type": `multipart/form-data; boundary=${form.boundary}` },
      payload: form.payload,
    });
    assert.equal(uploadRes.statusCode, 201);
    const assetId = uploadRes.json().assets[0].assetId;

    const previewRes = await app.inject({
      method: "GET", url: `/api/v1/assets/${assetId}/preview`,
      headers: { cookie: `jansee_session=${token}` },
    });
    assert.equal(previewRes.statusCode, 200, previewRes.body);
    assert.equal(previewRes.headers["content-type"], "image/png");
    assert.equal(previewRes.headers["cache-control"], "private, max-age=3600");
    assert.deepEqual(previewRes.rawPayload, pngHeader());

    const anonymousRes = await app.inject({ method: "GET", url: `/api/v1/assets/${assetId}/preview` });
    assert.equal(anonymousRes.statusCode, 401);

    const invalidRes = await app.inject({
      method: "GET", url: "/api/v1/assets/not-a-uuid/preview",
      headers: { cookie: `jansee_session=${token}` },
    });
    assert.equal(invalidRes.statusCode, 400);

    const missingRes = await app.inject({
      method: "GET", url: "/api/v1/assets/cccccccc-cccc-4ccc-8ccc-cccccccccccc/preview",
      headers: { cookie: `jansee_session=${token}` },
    });
    assert.equal(missingRes.statusCode, 404);
  } finally { await app.close(); }
});

test("cleanupExpiredAssets removes storage files and marks database assets", async () => {
  const s = stores();
  const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const storageKey = `users/user-123/${assetId}`;
  s.saved.set(storageKey, Buffer.from("test"));
  await s.assetStore.createAssets("user-123", [{
    id: assetId,
    originalName: "expired.png",
    mediaType: "image",
    mimeType: "image/png",
    sizeBytes: 4,
    sha256: "dummy",
    storageKey,
  }]);
  assert.equal(s.saved.size, 1);
  assert.equal(s.inserted.length, 1);

  const res = await cleanupExpiredAssets(s.assetStore, s.storage);
  assert.equal(res.databaseMarked, 1);
  assert.equal(res.storageDeleted, 1);
  assert.equal(s.saved.size, 0);
  assert.equal(s.inserted.length, 0);
});

test("cleanupExpiredAssets keeps database rows retryable when object deletion fails", async () => {
  const s = stores();
  const assetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const storageKey = `users/user-123/${assetId}`;
  s.saved.set(storageKey, Buffer.from("test"));
  await s.assetStore.createAssets("user-123", [{
    id: assetId,
    originalName: "expired.png",
    mediaType: "image",
    mimeType: "image/png",
    sizeBytes: 4,
    sha256: "dummy",
    storageKey,
  }]);
  const failingStorage: LocalObjectStorage = {
    async putFile() { throw new Error("not used"); },
    async getFilePath() { throw new Error("not used"); },
    async deleteObject() { throw new Error("COS unavailable"); },
    async deleteExpired() { return 0; },
  };

  const res = await cleanupExpiredAssets(s.assetStore, failingStorage);
  assert.equal(res.databaseMarked, 0);
  assert.equal(res.storageDeleted, 0);
  assert.equal(s.inserted.length, 1);
  assert.equal(s.saved.size, 1);
});
