# THIRD-PARTY-NOTICES

Mentions de licences des dépendances tierces utilisées par Homy. Les textes
légaux sont reproduits en anglais, dans leur version d'origine.

## Dépendances

| Dépendance | Version | Licence | Copyright |
|---|---|---|---|
| [gridstack](https://github.com/gridstack/gridstack.js) (vendored : `public/vendor/gridstack/`) | 13.2.0 | MIT | © 2019-2025 Alain Dumesny — v0.4.0 et antérieures © 2014-2018 Pavel Reznikov, Dylan Weiss |
| [hono](https://github.com/honojs/hono) | 4.13.7 | MIT | © 2021 - présent, Yusuke Wada and Hono contributors |
| [@hono/node-server](https://github.com/honojs/node-server) | 2.1.1 | MIT | © 2022 - présent, Yusuke Wada and Hono contributors |
| [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) | 9.0.3 | MIT | © 2015 Auth0, Inc. |
| [bcryptjs](https://github.com/dcodeIO/bcrypt.js) | 3.0.3 | BSD-3-Clause | © 2012 Nevins Bartolomeo, © 2012 Shane Girish, © 2025 Daniel Wirtz |

Les dépendances sous MIT listées ci-dessus sont régies par le texte MIT standard,
reproduit intégralement dans la section gridstack ci-dessous.

## gridstack — MIT

Le build vendored `public/vendor/gridstack/gridstack.min.js` embarque le bandeau
`For license information please see gridstack-all.js.LICENSE.txt`. Ce fichier est
disponible à côté du build (`public/vendor/gridstack/gridstack-all.js.LICENSE.txt`),
dont voici le contenu :

```
/*!
 * GridStack 13.2.0
 * https://gridstackjs.com/
 *
 * Copyright (c) 2021-2025  Alain Dumesny
 * see root license https://github.com/gridstack/gridstack.js/tree/master/LICENSE
 */
```

Texte complet de la licence (reproduit de `node_modules/gridstack/LICENSE`) :

```
MIT License

Copyright (c) 2019-2025 Alain Dumesny. v0.4.0 and older (c) 2014-2018 Pavel Reznikov, Dylan Weiss

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## bcryptjs — BSD-3-Clause

Texte reproduit de `node_modules/bcryptjs/LICENSE` :

```
bcrypt.js
---------
Copyright (c) 2012 Nevins Bartolomeo <nevins.bartolomeo@gmail.com>
Copyright (c) 2012 Shane Girish <shaneGirish@gmail.com>
Copyright (c) 2025 Daniel Wirtz <dcode@dcode.io>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. The name of the author may not be used to endorse or promote products
   derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```