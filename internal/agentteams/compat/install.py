"""Build-time patch of exactly the pinned v1.2.5 builtin plugin."""
import hashlib
from pathlib import Path
import shutil

root=Path('/opt/agentteams/qwenpaw-builtin/plugins/teamharness')
server=root/'teamharness/mcp/server.py'
source=server.read_bytes()
assert hashlib.sha256(source).hexdigest()=='78ad0267f8b5ca297da6d56a95d92d241d9a4e31f3fcae1d0458be08dc1fb417','unrecognized upstream; review before patching'
anchor='if __name__ == "__main__":\n'
text=source.decode();assert text.count(anchor)==1
# Import also applies when an operator resumes the exact original submission.
text=text.replace(anchor,'from pocketctl_filesync import wrap_filesync\n_filesync = wrap_filesync(sys.modules[__name__])\n\n'+anchor)
server.write_text(text)
shutil.copyfile(Path(__file__).with_name('pocketctl_filesync.py'),server.with_name('pocketctl_filesync.py'))
marker='.agentteams-builtin-plugin.sha256';digest=hashlib.sha256()
for path in sorted(root.rglob('*')):
    if not path.is_file() or path.name==marker:continue
    digest.update(path.relative_to(root).as_posix().encode());digest.update(b'\0');digest.update(path.read_bytes());digest.update(b'\0')
(root/marker).write_text(digest.hexdigest()+'\n')
print('Pinned TeamHarness identical-byte compatibility installed')
