/**
 * Minimal fetch client. Attaches the JWT, parses JSON, and emits an
 * `auth:expired` event on 401 so the app can return to the login view.
 */
export const api = {
  token: localStorage.getItem('hp_token') || null,

  setToken(token) {
    this.token = token;
    if (token) localStorage.setItem('hp_token', token);
    else localStorage.removeItem('hp_token');
  },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }

    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  patch(path, body) { return this.request('PATCH', path, body); },
  del(path) { return this.request('DELETE', path); },
};
