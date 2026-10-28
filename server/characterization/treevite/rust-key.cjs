"use strict";
// Loaded only by the sealed differential profile. Share this run's ephemeral
// key with the Rust process, then remove it in the profile's cleanup trap.
const crypto=require("node:crypto"),fs=require("node:fs");
const generate=crypto.generateKeyPairSync;
crypto.generateKeyPairSync=function(...args){
  const pair=generate.apply(this,args);
  if(args[0]==="rsa" && typeof pair.privateKey==="string") {
    fs.writeFileSync("/artifacts/treevite-rust-private.pem",pair.privateKey,{mode:0o600});
    fs.writeFileSync("/artifacts/treevite-rust-public.pem",pair.publicKey,{mode:0o600});
    crypto.generateKeyPairSync=generate;
  }
  return pair;
};
