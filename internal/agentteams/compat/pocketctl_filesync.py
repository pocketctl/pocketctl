"""AgentTeams v1.2.5 compatibility for unchanged PocketCtl task uploads.

Upstream rejects a second upload when remote mtime is newer even if its bytes
are identical. On that exact conflict only, verify bounded bytes and reuse the
remote object without writing either copy. Real conflicts remain fail closed.
"""
import os
import re
import stat
import subprocess
import threading

MAX_BYTES=2*1024*1024
TASK_PATH=re.compile(r'^shared/tasks/pctl-[0-9a-f]{32}-01/(?:[^/]+/)*[^/]+$')

def wrap_filesync(module):
    original=module._filesync
    def filesync(arguments):
        result=original(arguments)
        if arguments.get('action')!='push' or not result.get('conflict') or result.get('ok'):
            return result
        proc=None;timer=None
        try:
            action,path,local,remote,directory=module._resolve_filesync(arguments)
            if action!='push' or directory or not TASK_PATH.fullmatch(path):return result
            if any(part in ('.','..') for part in path.split('/')):return result
            with os.fdopen(os.open(local,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:
                info=os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size>MAX_BYTES:return result
                data=stream.read(MAX_BYTES+1)
                if len(data)>MAX_BYTES:return result
            env,error=module._filesync_mc_env(remote)
            if error:return result
            proc=subprocess.Popen(['mc','cat',remote],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env)
            timer=threading.Timer(20,proc.kill);timer.daemon=True;timer.start()
            actual=proc.stdout.read(len(data)+1)
            if len(actual)>len(data):proc.kill()
            if proc.wait(timeout=5)!=0 or actual!=data:return result
            # Detect a concurrent local write/replacement before acknowledging.
            with os.fdopen(os.open(local,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:
                current=os.fstat(stream.fileno())
                if (current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns)!=(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns):return result
                if stream.read(MAX_BYTES+1)!=data:return result
            return {'ok':True,'tool':'filesync','action':'push','path':path,
                    'reused':True,'verifiedUnchanged':True}
        except (OSError,ValueError,subprocess.SubprocessError):
            return result
        finally:
            if timer is not None:timer.cancel()
            if proc is not None:
                if proc.poll() is None:proc.kill();proc.wait()
                if proc.stdout is not None:proc.stdout.close()
    return filesync
