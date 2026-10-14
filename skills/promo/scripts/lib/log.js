// Every line written passes through scrub(), so a secret value never reaches stdout or stderr.
export function createLogger({ secrets = [] } = {}) {
  const values = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  const scrub = (s) => values.reduce((out, secret) => out.split(secret).join('***'), String(s));
  return {
    info: (msg) => process.stdout.write(`${scrub(msg)}\n`),
    error: (msg) => process.stderr.write(`${scrub(msg)}\n`),
    scrub,
  };
}
