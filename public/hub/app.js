/**
 * Hub-Logik. Vorher standen ~295 Zeilen inline im HTML: nicht cachebar,
 * keine Source Maps und eine CSP ohne 'unsafe-inline' war unmöglich.
 */
(function () {
    'use strict';

    const { escapeHtml, safeImageUrl, el, clear, readableTextColor, debounce, makeAccessibleModal } = window.DomUtils;

    const DEFAULT_AVATAR = 'https://static-cdn.jtvnw.net/user-default-pictures-uv/cdd517fe-def4-11e9-948e-784f43822e80-profile_image-70x70.png';

    let currentUserData = null;

    const ACHIEVEMENT_TIERS = [
        { id: 'q1', targetKey: 'chess', targetWins: 5, icon: '🚀', title: 'Speed Cadet', desc: 'Win 5 Quickchess games', color: '#f1c40f', tier: 'TIER I', level: 1 },
        { id: 'q2', targetKey: 'chess', targetWins: 15, icon: '🔥', title: 'Speed Demon', desc: 'Win 15 Quickchess games', color: '#f39c12', tier: 'TIER II', level: 2 },
        { id: 'q3', targetKey: 'chess', targetWins: 50, icon: '⚡', title: 'Light Speed', desc: 'Win 50 Quickchess games', color: '#e67e22', tier: 'TIER III', level: 3 },

        { id: 'm1', targetKey: 'mutant', targetWins: 5, icon: '🧪', title: 'Gene Splicer', desc: 'Win 5 Mutant games', color: '#2ecc71', tier: 'TIER I', level: 1 },
        { id: 'm2', targetKey: 'mutant', targetWins: 15, icon: '🧬', title: 'Mad Scientist', desc: 'Win 15 Mutant games', color: '#27ae60', tier: 'TIER II', level: 2 },
        { id: 'm3', targetKey: 'mutant', targetWins: 50, icon: '🦠', title: 'Super Mutant', desc: 'Win 50 Mutant games', color: '#16a085', tier: 'TIER III', level: 3 },

        { id: 'b1', targetKey: 'bot', targetWins: 1, icon: '🔌', title: 'Bot Buster', desc: 'Defeat Cager Bot once', color: '#9b59b6', tier: 'TIER I', level: 1 },
        { id: 'b2', targetKey: 'bot', targetWins: 10, icon: '🛠️', title: 'AI Nemesis', desc: 'Defeat Cager Bot 10 times', color: '#8e44ad', tier: 'TIER II', level: 2 },
        { id: 'b3', targetKey: 'bot', targetWins: 30, icon: '💾', title: 'Cager Slayer', desc: 'Defeat Cager Bot 30 times', color: '#2c3e50', tier: 'TIER III', level: 3 },

        { id: 't1', targetKey: 'total', targetWins: 10, icon: '⭐', title: 'Rising Star', desc: 'Win 10 games in total', color: '#3498db', tier: 'TIER I', level: 1 },
        { id: 't2', targetKey: 'total', targetWins: 50, icon: '🌟', title: 'Chess Master', desc: 'Win 50 games in total', color: '#e74c3c', tier: 'TIER II', level: 2 },
        { id: 't3', targetKey: 'total', targetWins: 100, icon: '👑', title: 'Cager Legend', desc: 'Win 100 games in total', color: '#d35400', tier: 'TIER III', level: 3 }
    ];

    // =====================================================================
    // PROFIL-MODAL
    // =====================================================================
    const modalEl = document.getElementById('profile-modal');
    const closeBtn = document.getElementById('close-modal-btn');
    const modal = makeAccessibleModal(modalEl);

    closeBtn.addEventListener('click', () => modal.close());
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) modal.close(); });

    function openProfileModal(userData) {
        const data = userData || currentUserData;
        if (!data) return;

        const avatar = document.getElementById('modal-avatar');
        avatar.src = safeImageUrl(data.profileImageUrl, DEFAULT_AVATAR);
        avatar.alt = `Avatar von ${data.displayName || 'Spieler'}`;
        document.getElementById('modal-username').textContent = data.displayName || 'User Profile';

        const stats = data.stats || {};
        renderStatBox('chess', stats.chess);
        renderStatBox('mutant', stats.mutant);
        renderStatBox('bot', stats.bot);
        renderAchievements(stats);

        modal.open();
    }

    function renderStatBox(key, data) {
        const wins = (data && data.wins) || 0;
        const losses = (data && data.losses) || 0;
        const draws = (data && data.draws) || 0;
        const total = wins + losses + draws;
        const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
        document.getElementById(`st-${key}-record`).textContent = `${wins} W / ${losses} L / ${draws} D`;
        document.getElementById(`st-${key}-wr`).textContent = `${wr}% WR`;
    }

    function renderAchievements(stats) {
        const container = document.getElementById('achievements-container');
        clear(container);

        const cWins = (stats.chess && stats.chess.wins) || 0;
        const mWins = (stats.mutant && stats.mutant.wins) || 0;
        const bWins = (stats.bot && stats.bot.wins) || 0;
        const totalWins = cWins + mWins + bWins;
        const byKey = { chess: cWins, mutant: mWins, bot: bWins, total: totalWins };

        ACHIEVEMENT_TIERS.forEach(ach => {
            const currentWins = byKey[ach.targetKey] || 0;
            const isUnlocked = currentWins >= ach.targetWins;

            const card = el('div', {
                class: `achievement-card ${isUnlocked ? 'unlocked' : 'locked'} tier-${ach.level}`
            });

            if (isUnlocked) {
                card.style.backgroundColor = ach.color;
                // Vorher blieb der Text immer bei #111 — auf #2c3e50 ergab das
                // 1.6:1 Kontrast. Jetzt wird die lesbare Farbe berechnet.
                card.style.color = readableTextColor(ach.color);
            }

            card.appendChild(el('div', { class: 'icon', 'aria-hidden': 'true' }, ach.icon));
            card.appendChild(el('div', { class: 'title' }, ach.title));
            card.appendChild(el('div', { class: 'desc' },
                `${ach.desc} (${Math.min(currentWins, ach.targetWins)}/${ach.targetWins})`));
            card.appendChild(el('div', { class: 'tier-tag' }, ach.tier));

            card.setAttribute('role', 'listitem');
            card.setAttribute('aria-label',
                `${ach.title}, ${ach.tier}, ${isUnlocked ? 'freigeschaltet' : 'gesperrt'}: ${ach.desc}, Fortschritt ${Math.min(currentWins, ach.targetWins)} von ${ach.targetWins}`);

            container.appendChild(card);
        });
    }

    // =====================================================================
    // SPIELERSUCHE — debounced, abbrechbar, escaped
    // =====================================================================
    const searchInput = document.getElementById('user-search');
    const searchResults = document.getElementById('search-results');
    let searchAbort = null;

    const runSearch = debounce(async (query) => {
        if (searchAbort) searchAbort.abort();
        searchAbort = new AbortController();

        try {
            // encodeURIComponent fehlte komplett — Sonderzeichen zerlegten die URL.
            const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`, {
                signal: searchAbort.signal
            });
            if (!res.ok) throw new Error('search failed');
            const users = await res.json();

            clear(searchResults);
            if (!Array.isArray(users) || users.length === 0) {
                const empty = el('div', { class: 'search-item' }, 'No player found');
                empty.style.color = '#777';
                searchResults.appendChild(empty);
            } else {
                users.forEach(u => {
                    const item = el('div', { class: 'search-item' });
                    item.appendChild(el('img', {
                        src: safeImageUrl(u.profileImageUrl, DEFAULT_AVATAR),
                        class: 'search-avatar',
                        alt: '',
                        loading: 'lazy'
                    }));
                    // textContent statt innerHTML: displayName kann nichts mehr ausführen.
                    item.appendChild(el('span', null, ' ' + (u.displayName || '')));
                    const activate = () => {
                        searchResults.classList.add('hidden');
                        searchInput.value = '';
                        openProfileModal(u);
                    };
                    item.addEventListener('click', activate);
                    window.DomUtils.makeKeyboardActivatable(item, activate, `Profil von ${u.displayName} öffnen`);
                    searchResults.appendChild(item);
                });
            }
            searchResults.classList.remove('hidden');
        } catch (err) {
            if (err.name !== 'AbortError') console.error('Search failed:', err);
        }
    }, 250);

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        if (query.length < 2) {
            if (searchAbort) searchAbort.abort();
            clear(searchResults);
            searchResults.classList.add('hidden');
            return;
        }
        runSearch(query);
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
            searchResults.classList.add('hidden');
        }
    });

    // =====================================================================
    // AUTH
    // =====================================================================
    function renderAuth(user) {
        const authSection = document.getElementById('auth-section');
        clear(authSection);

        if (user) {
            currentUserData = user;

            const wrap = el('div', { class: 'profile-info', id: 'user-profile-trigger' });
            wrap.appendChild(el('img', {
                src: safeImageUrl(user.profileImageUrl, DEFAULT_AVATAR),
                alt: '', class: 'avatar scribble-avatar', loading: 'lazy'
            }));
            wrap.appendChild(el('span', { class: 'user-name' }, user.displayName || ''));
            const logout = el('a', { href: '/auth/logout', class: 'logout-link', id: 'logout-btn' }, 'Logout');
            wrap.appendChild(logout);
            authSection.appendChild(wrap);

            const openOwn = () => openProfileModal(currentUserData);
            wrap.addEventListener('click', openOwn);
            window.DomUtils.makeKeyboardActivatable(wrap, openOwn, 'Eigenes Profil öffnen');
            logout.addEventListener('click', (e) => e.stopPropagation());

            try {
                localStorage.setItem('cager_twitch_name', user.displayName || '');
                localStorage.setItem('cager_twitch_pfp', safeImageUrl(user.profileImageUrl, ''));
            } catch (e) { /* Storage kann blockiert sein */ }
        } else {
            const a = el('a', { href: '/auth/twitch', class: 'twitch-btn scribble-btn' });
            a.innerHTML = '<svg width="20" height="20" fill="white" viewBox="0 0 24 24" aria-hidden="true"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>';
            a.appendChild(document.createTextNode(' Login with Twitch'));
            authSection.appendChild(a);

            try {
                localStorage.removeItem('cager_twitch_name');
                localStorage.removeItem('cager_twitch_pfp');
            } catch (e) { /* ignore */ }
        }
    }

    fetch('/api/user')
        .then(res => res.json())
        .then(user => { renderAuth(user); updateChatInputState(user); })
        .catch(err => {
            console.error('User Auth Fetch Error:', err);
            renderAuth(null);
            updateChatInputState(null);
        });

    // =====================================================================
    // HALL OF FAME
    // =====================================================================
    fetch('/api/leaderboard')
        .then(res => res.json())
        .then(users => {
            const hofList = document.getElementById('hof-list');
            clear(hofList);
            const medals = ['🥇', '🥈', '🥉'];

            if (!Array.isArray(users) || users.length === 0) {
                const p = el('p', null, 'No games played yet!');
                p.style.textAlign = 'center';
                p.style.color = '#555';
                hofList.appendChild(p);
                return;
            }

            users.forEach((u, index) => {
                const item = el('div', { class: 'hof-item scribble-box' });
                item.appendChild(el('div', { class: 'hof-rank' }, medals[index] || '#' + (index + 1)));
                item.appendChild(el('img', {
                    src: safeImageUrl(u.profileImageUrl, DEFAULT_AVATAR),
                    class: 'hof-avatar', alt: '', loading: 'lazy'
                }));
                const info = el('div', { class: 'hof-info' });
                info.appendChild(el('span', { class: 'hof-name' }, u.displayName || ''));
                info.appendChild(el('span', { class: 'hof-wins' }, `${u.totalWins || 0} Wins total`));
                item.appendChild(info);

                item.style.cursor = 'pointer';
                const activate = () => openProfileModal(u);
                item.addEventListener('click', activate);
                window.DomUtils.makeKeyboardActivatable(item, activate, `Profil von ${u.displayName} öffnen`);
                hofList.appendChild(item);
            });
        })
        .catch(err => console.error('Leaderboard Error:', err));

    // =====================================================================
    // HUB-CHAT & ONLINE-ZÄHLER
    // =====================================================================
    const hubSocket = io();
    const chatBox = document.getElementById('hub-chat-box');
    const chatToggleBtn = document.getElementById('hub-chat-toggle-btn');
    const chatMessages = document.getElementById('hub-chat-messages');
    const chatInputArea = document.getElementById('hub-chat-input-area');
    let chatReady = false;

    hubSocket.on('online_players_count', (count) => {
        const countEl = document.getElementById('online-count');
        if (countEl) countEl.textContent = String(count || 1);
    });

    chatToggleBtn.addEventListener('click', () => {
        chatBox.classList.toggle('collapsed');
        const collapsed = chatBox.classList.contains('collapsed');
        chatToggleBtn.textContent = collapsed ? '🙈 Show' : '👁️ Hide';
        chatToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });

    function updateChatInputState(user) {
        clear(chatInputArea);

        if (user) {
            const input = el('input', {
                type: 'text', id: 'hub-chat-input',
                class: 'scribble-input hub-chat-input',
                placeholder: 'Type a message...',
                'aria-label': 'Chat-Nachricht',
                maxlength: '150'
            });
            const sendBtn = el('button', {
                type: 'button', id: 'hub-chat-send-btn',
                class: 'scribble-btn hub-chat-send-btn'
            }, 'Send');

            chatInputArea.appendChild(input);
            chatInputArea.appendChild(sendBtn);

            const sendMessage = () => {
                const text = input.value.trim();
                if (!text) return;
                // Absender bestimmt jetzt der Server aus der Session —
                // der Client schickt nur noch den Text.
                hubSocket.emit('send_hub_chat', { text });
                input.value = '';
            };

            sendBtn.addEventListener('click', sendMessage);
            input.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
        } else {
            const notice = el('div', { class: 'hub-chat-login-notice' });
            notice.appendChild(document.createTextNode('🔒 '));
            const link = el('a', { href: '/auth/twitch' }, 'Log in with Twitch');
            link.style.color = '#9146FF';
            link.style.fontWeight = 'bold';
            link.style.textDecoration = 'underline';
            notice.appendChild(link);
            notice.appendChild(document.createTextNode(' to chat!'));
            chatInputArea.appendChild(notice);
        }
    }

    function appendHubChatMessage(msg, playSound) {
        const msgEl = el('div', { class: 'hub-chat-msg' });
        msgEl.appendChild(el('img', {
            src: safeImageUrl(msg.pfp, DEFAULT_AVATAR),
            class: 'hub-chat-avatar', alt: '', loading: 'lazy'
        }));
        const content = el('div', { class: 'hub-chat-content' });
        // Vorher war nur msg.text escaped — msg.name direkt daneben nicht.
        content.appendChild(el('span', { class: 'hub-chat-user' }, msg.name || 'Guest'));
        content.appendChild(el('span', { class: 'hub-chat-text' }, msg.text || ''));
        msgEl.appendChild(content);

        chatMessages.appendChild(msgEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        if (playSound && window.Sfx) window.Sfx.play('notify', { volume: 0.5 });
    }

    function showChatPlaceholder(text) {
        clear(chatMessages);
        const ph = el('div', { class: 'hub-chat-placeholder' }, text);
        ph.style.textAlign = 'center';
        ph.style.color = '#888';
        ph.style.fontStyle = 'italic';
        chatMessages.appendChild(ph);
    }

    hubSocket.on('hub_chat_history', (history) => {
        if (!Array.isArray(history) || history.length === 0) {
            showChatPlaceholder('No messages yet...');
        } else {
            clear(chatMessages);
            history.forEach(m => appendHubChatMessage(m, false));
        }
        chatReady = true;
    });

    hubSocket.on('receive_hub_chat', (msg) => {
        const placeholder = chatMessages.querySelector('.hub-chat-placeholder');
        if (placeholder) placeholder.remove();
        appendHubChatMessage(msg, chatReady);
    });

    hubSocket.on('error_msg', (msg) => {
        console.warn('Hub:', msg);
    });

    // Sound-Umschalter (die Einstellung gilt für alle Spiele).
    if (window.Sfx) window.Sfx.mountFloatingToggle();

    // Nur damit escapeHtml nicht als "ungenutzt" durchrutscht — wird für
    // etwaige künftige Template-Stellen bereitgehalten.
    void escapeHtml;
})();
