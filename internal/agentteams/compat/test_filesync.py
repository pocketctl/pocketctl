import io
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from pocketctl_filesync import wrap_filesync

class Process:
    def __init__(self, data, code=0):
        self.stdout=io.BytesIO(data);self.code=code;self.killed=False
    def wait(self, timeout=None):return self.code
    def poll(self):return self.code
    def kill(self):self.killed=True

class FilesyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.local=Path(self.tmp.name)/'result.md';self.local.write_bytes(b'original\x00\xff')
        self.path='shared/tasks/pctl-'+'a'*32+'-01/result.md'
        self.conflict={'ok':False,'conflict':True,'error':'remote copy is newer'}
        self.calls=[]
        self.module=types.SimpleNamespace(
          _filesync=lambda a:self.conflict,
          _resolve_filesync=lambda a:('push',self.path,self.local,'fixed-alias/fixed-bucket/'+self.path,False),
          _filesync_mc_env=lambda remote:({},None))
        self.sync=wrap_filesync(self.module)
    def run_remote(self,data):
        with patch('pocketctl_filesync.subprocess.Popen',return_value=Process(data)) as proc:
            value=self.sync({'action':'push','path':self.path})
        return value,proc
    def test_identical_bytes_reuse_without_upload(self):
        value,proc=self.run_remote(self.local.read_bytes())
        self.assertTrue(value['ok']);self.assertTrue(value['verifiedUnchanged'])
        self.assertEqual(proc.call_args.args[0][:2],['mc','cat'])
        self.assertEqual(self.local.read_bytes(),b'original\x00\xff')
    def test_changed_remote_is_still_conflict(self):
        value,_=self.run_remote(b'different');self.assertIs(value,self.conflict)
    def test_longer_remote_is_still_conflict(self):
        value,_=self.run_remote(self.local.read_bytes()+b'extra');self.assertIs(value,self.conflict)
    def test_non_pocketctl_task_unchanged(self):
        self.path='shared/tasks/foreign/result.md'
        value,proc=self.run_remote(b'original\x00\xff');self.assertIs(value,self.conflict);proc.assert_not_called()
    def test_directory_unchanged(self):
        self.module._resolve_filesync=lambda a:('push',self.path,self.local,'remote',True)
        value,proc=self.run_remote(b'original\x00\xff');self.assertIs(value,self.conflict);proc.assert_not_called()
    def test_symlink_rejected(self):
        actual=self.local.with_name('actual');self.local.rename(actual);self.local.symlink_to(actual)
        value,proc=self.run_remote(b'original\x00\xff');self.assertIs(value,self.conflict);proc.assert_not_called()
    def test_size_limit_rejected(self):
        self.local.write_bytes(b'x'*(2*1024*1024+1))
        value,proc=self.run_remote(b'');self.assertIs(value,self.conflict);proc.assert_not_called()
    def test_success_is_not_probed(self):
        self.module._filesync=lambda a:{'ok':True};self.sync=wrap_filesync(self.module)
        value,proc=self.run_remote(b'');self.assertTrue(value['ok']);proc.assert_not_called()
    def test_auth_or_transport_failure_keeps_conflict(self):
        self.module._filesync_mc_env=lambda remote:({},'unavailable')
        value,proc=self.run_remote(b'');self.assertIs(value,self.conflict);proc.assert_not_called()
        self.module._filesync_mc_env=lambda remote:({},None)
        with patch('pocketctl_filesync.subprocess.Popen',side_effect=OSError('private')):
            self.assertIs(self.sync({'action':'push','path':self.path}),self.conflict)
    def test_failed_remote_read_keeps_conflict(self):
        with patch('pocketctl_filesync.subprocess.Popen',return_value=Process(self.local.read_bytes(),1)):
            self.assertIs(self.sync({'action':'push','path':self.path}),self.conflict)

if __name__=='__main__':unittest.main()
