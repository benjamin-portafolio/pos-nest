# Ensayo aislado de la CLI compilada en una PTY Unix. No toca el .env real.
import os, subprocess, pty, select, time, tempfile, pathlib, struct, fcntl, termios, json, signal
repo=pathlib.Path(__file__).resolve().parents[2]
secret='  Instalación prueba 🔑 con espacios  '
def controlling_terminal():
    os.setsid()
    fcntl.ioctl(0,termios.TIOCSCTTY,0)

class Session:
    def __init__(self,path):
        self.master,slave=pty.openpty();self.output=b'';self.cursor=0
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
        self.process=subprocess.Popen(['node',str(repo/'dist/recovery/configure-recovery-admin.js'),'--env-file',str(path)],stdin=slave,stdout=slave,stderr=slave,cwd='/tmp',env={**os.environ,'TERM':'xterm-256color','NO_COLOR':'1'},preexec_fn=controlling_terminal)
        os.close(slave)
    def wait_text(self,text):
        end=time.time()+25;needle=text.encode()
        while needle not in self.output[self.cursor:]:
            if time.time()>end: raise AssertionError('Timed out waiting for CLI prompt: '+text)
            if select.select([self.master],[],[],.2)[0]:
                try:chunk=os.read(self.master,65536)
                except OSError:chunk=b''
                if not chunk: raise AssertionError('CLI exited before prompt: '+text)
                self.output+=chunk
        self.cursor=self.output.index(needle,self.cursor)+len(needle)
    def send(self,text):os.write(self.master,text.encode())
    def finish(self):
        end=time.time()+5
        while self.process.poll() is None and time.time()<end:
            if select.select([self.master],[],[],.1)[0]:
                try:chunk=os.read(self.master,65536)
                except OSError:chunk=b''
                self.output+=chunk
        if self.process.poll() is None:
            print('Cancellation trace:',repr(self.output[-1600:].decode(errors='replace')))
            raise AssertionError('CLI did not exit')
        while select.select([self.master],[],[],.1)[0]:
            try:chunk=os.read(self.master,65536)
            except OSError:break
            if not chunk:break
            self.output+=chunk
        os.close(self.master)
        assert secret.encode() not in self.output,'CLI leaked the chosen password'
        return self.process.returncode
with tempfile.TemporaryDirectory(prefix='pos-admin-cli-') as temporary:
    path=pathlib.Path(temporary)/'.env'
    path.write_text('DATABASE_HOST=fixture-only\nPOS_RECOVERY_ADMIN_TOKEN_SHA256='+('a'*64)+'\n')
    session=Session(path)
    try:
        session.wait_text('Nueva contraseña');session.send(secret+'\r')
        session.wait_text('Repite la contraseña');session.send('No coincide esta contraseña\r')
        session.wait_text('Las contraseñas no coinciden.');session.send('\x15'+secret+'\r')
        session.wait_text('guardada con Argon2id');assert session.finish()==0
    finally:
        if session.process.poll() is None:session.process.kill()
    stored=path.read_text(); assert secret not in stored and 'DATABASE_HOST=fixture-only' in stored
    assert 'TOKEN_SHA256=' not in stored and 'PASSWORD_HASH=' in stored
    # Independently verify the exact password with the production verifier and dotenv loader.
    script="const fs=require('fs');const dotenv=require('dotenv');const auth=require('./dist/recovery/recovery-admin-password');const c=dotenv.parse(fs.readFileSync(process.argv[1]));auth.verifyAdminPasswordHash(c.POS_RECOVERY_ADMIN_PASSWORD_HASH,JSON.parse(process.argv[2])).then(ok=>process.exit(ok?0:1))"
    subprocess.run(['node','-e',script,str(path),json.dumps(secret)],cwd=repo,check=True,capture_output=True)
    cancelled=Session(path)
    try:
        cancelled.wait_text('Nueva contraseña');cancelled.wait_text('[input is masked]');cancelled.send('\x03');assert cancelled.finish()!=0
    finally:
        if cancelled.process.poll() is None:cancelled.process.kill()
    assert path.read_text()==stored,'Cancellation changed the environment'
    print('PTY verified: hidden input, Unicode/spaces, confirmation retry, dotenv preservation, legacy revocation, Argon2 verification, cancellation without changes.')
