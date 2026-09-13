import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Field, errorMessage } from '../../components/ui';

export function LoginPage() {
  const { login, login2fa } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [twoFactorToken, setTwoFactorToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (twoFactorToken) {
        await login2fa(twoFactorToken, code);
      } else {
        const r = await login(email, password);
        if (r.twoFactorRequired) { setTwoFactorToken(r.twoFactorToken!); return; }
      }
      nav('/');
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Acesso da equipe</h1>
        <p className="sub">Gestão de empréstimos</p>
        {error && <div className="alert error">{error}</div>}
        {twoFactorToken ? (
          <>
            <div className="alert info">Informe o código de 6 dígitos do seu aplicativo autenticador.</div>
            <Field label="Código de verificação"><input autoFocus inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
          </>
        ) : (
          <>
            <Field label="E-mail"><input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Senha"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          </>
        )}
        <button className="btn primary block" disabled={busy}>{busy ? 'Entrando...' : 'Entrar'}</button>
        <div className="mt small" style={{ textAlign: 'center' }}><Link to="/recuperar-senha">Esqueci minha senha</Link></div>
      </form>
    </div>
  );
}

export function ForgotPasswordPage({ portalSlug }: { portalSlug?: string }) {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { api } = await import('../../lib/api');
      await api('auth/forgot-password', { body: { email, companySlug: portalSlug } });
      setDone(true);
    } catch (err) { setError(errorMessage(err)); }
  };
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Recuperar senha</h1>
        <p className="sub">Enviaremos um link para redefinir sua senha.</p>
        {error && <div className="alert error">{error}</div>}
        {done ? <div className="alert success">Se o e-mail estiver cadastrado, você receberá as instruções em instantes.</div> : (
          <>
            <Field label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <button className="btn primary block">Enviar link</button>
          </>
        )}
        <div className="mt small" style={{ textAlign: 'center' }}><Link to={portalSlug ? `/portal/${portalSlug}/login` : '/login'}>Voltar ao login</Link></div>
      </form>
    </div>
  );
}

export function ResetPasswordPage({ portalSlug }: { portalSlug?: string }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('As senhas não conferem');
    try {
      const { api } = await import('../../lib/api');
      await api('auth/reset-password', { body: { token, password } });
      setDone(true);
    } catch (err) { setError(errorMessage(err)); }
  };
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Definir nova senha</h1>
        <p className="sub">Mínimo de 8 caracteres, com letras e números.</p>
        {error && <div className="alert error">{error}</div>}
        {done ? <div className="alert success">Senha redefinida. <Link to={portalSlug ? `/portal/${portalSlug}/login` : '/login'}>Entrar</Link></div> : (
          <>
            <Field label="Nova senha"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            <Field label="Confirmar senha"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
            <button className="btn primary block">Salvar</button>
          </>
        )}
      </form>
    </div>
  );
}
