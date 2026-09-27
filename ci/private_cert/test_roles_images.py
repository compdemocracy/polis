"""Fixture OCI controls for all three census recipes; no runtime/cloud build."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).parent
sys.path.insert(0,str(HERE));sys.path.insert(0,str(HERE/'images'));sys.path.insert(0,str(HERE.parent/'probe_box'))
from control import encoded,sha
from image_admission import CONFIG,LAYER,MANIFEST,validate_recipe
from test_image_admission import tar_bytes,config
from roles_recipe import recipe
from roles_registry import admit


def archive(path,r,source):
    files={'opt/polis-private-image/recipe.json':encoded(r),
        'opt/polis-private-image/launcher.py':(HERE/'images/launcher.py').read_bytes(),
        **{'opt/polis-private-image/payload/'+p:(source/p).read_bytes() for p in r['files']}}
    layer=tar_bytes(files);blobs={}
    def desc(raw,media):
        digest=hashlib.sha256(raw).hexdigest();blobs['blobs/sha256/'+digest]=raw
        return dict(mediaType=media,digest='sha256:'+digest,size=len(raw))
    cfg=encoded(dict(architecture='arm64',os='linux',config=config(r),
        rootfs=dict(type='layers',diff_ids=['sha256:'+hashlib.sha256(layer).hexdigest()])))
    manifest=encoded(dict(schemaVersion=2,mediaType=MANIFEST,config=desc(cfg,CONFIG),layers=[desc(layer,LAYER)]))
    index=encoded(dict(schemaVersion=2,manifests=[desc(manifest,MANIFEST)]))
    path.write_bytes(tar_bytes({'oci-layout':encoded({'imageLayoutVersion':'1.0.0'}),'index.json':index,**blobs}))
    return path


class RolesImages(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        source=HERE.parents[1]
        self.recipes={r:recipe(source,r,'localhost/runtime@sha256:'+'1'*64) for r in ('reader','producer','verifier')}
        self.paths={r:archive(self.root/(r+'.oci.tar'),s,source) for r,s in self.recipes.items()}
        self.review=dict(schema='polis-roles-image-review/1',recipeSha256={r:sha(s) for r,s in self.recipes.items()},reviewSha256='2'*64)

    def test_three_distinct_archives_and_exact_commands(self):
        job,images=admit(self.paths,self.recipes,self.review)
        self.assertEqual([job[r]['args'] for r in ('reader','producer','verifier')],[['read'],['produce'],['verify']])
        self.assertEqual(len({i['manifestDigest'] for i in images.values()}),3)
        for image in images.values():self.assertEqual(len({image['manifestDigest'][7:],image['configDigest'][7:],image['archiveSha256']}),3)

    def test_swapped_archives_refused(self):
        paths=dict(self.paths,reader=self.paths['producer'])
        with self.assertRaises(ValueError):admit(paths,self.recipes,self.review)

    def test_changed_recipe_source_or_review_refused(self):
        for role in self.recipes:
            recipes=copy.deepcopy(self.recipes);recipes[role]['sourceCommit']='0'*40
            with self.assertRaises(ValueError):admit(self.paths,recipes,self.review)
        review=copy.deepcopy(self.review);del review['recipeSha256']['reader']
        with self.assertRaises(ValueError):admit(self.paths,self.recipes,review)

    def test_launcher_admits_only_the_role_action(self):
        import launcher
        source=HERE.parents[1]
        original_read=Path.read_bytes
        for role,action in (('reader','read'),('producer','produce'),('verifier','verify')):
            root=self.root/role;payload=root/'payload';payload.mkdir(parents=True)
            r=self.recipes[role];(root/'recipe.json').write_bytes(encoded(r))
            for name in r['files']:
                target=payload/name;target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes((source/name).read_bytes())
            def read(path):
                if str(path)=='/run-spec/inputs.json':
                    return encoded({k:r[k] for k in ('candidateSha','oracleSha','policySha256')})
                return original_read(path)
            with patch.object(launcher,'ROOT',root), patch.object(launcher.sys,'argv',['launcher',action]), \
                 patch.object(Path,'read_bytes',read), patch.object(launcher.os,'chdir'), \
                 patch.object(launcher.os,'execve') as execute:
                launcher.main()
                self.assertEqual(execute.call_args.args[1][-1],action)
                self.assertIn(role+'.py',execute.call_args.args[1][-2])
            with patch.object(launcher,'ROOT',root),patch.object(launcher.sys,'argv',['launcher','extract']):
                with self.assertRaisesRegex(ValueError,'IMAGE_ACTION'):launcher.main()

    def test_legacy_schema_cannot_admit_reader(self):
        r=copy.deepcopy(self.recipes['reader']);r['schema']='polis-private-image-recipe/1';del r['kind']
        with self.assertRaises(ValueError):validate_recipe(r)


if __name__=='__main__':unittest.main()
