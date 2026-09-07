const API = '/api/admin';
let currentPage = 'dashboard';
let currentFilter = 'all';
let selectedChatPhone = null;

const token = localStorage.getItem('token');
if (!token) window.location.href = '/admin/login.html';

const admin = JSON.parse(localStorage.getItem('admin') || '{}');
document.getElementById('adminName').textContent = admin.name || admin.email || '';
document.getElementById('hotelName').textContent = admin.hotel_name || 'Hotel CRM';

document.getElementById('logoutBtn').onclick = () => {
  localStorage.clear();
  window.location.href = '/admin/login.html';
};

document.getElementById('refreshBtn').onclick = () => loadPage(currentPage);

document.querySelectorAll('.nav-item').forEach((el) => {
  el.onclick = () => {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    el.classList.add('active');
    currentFilter = 'all';
    loadPage(el.dataset.page);
  };
});

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Server returned an invalid response. Check that MySQL is running.');
  }
  const data = await res.json();
  if (res.status === 401) {
    localStorage.clear();
    window.location.href = '/admin/login.html';
    return;
  }
  if (!data.success) throw new Error(data.error || 'Request failed');
  return data.data;
}

function badge(status) {
  const cls = (status || '').replace(/\s/g, '_');
  return `<span class="badge badge-${cls}">${(status || '').replace(/_/g, ' ')}</span>`;
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function showModal(html) {
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
  wireDatePickers();
}

function hideModal() {
  document.getElementById('modal').classList.add('hidden');
}

/** Open native calendar when clicking / focusing date fields */
function wireDatePickers() {
  document.querySelectorAll('input[type="date"]').forEach((el) => {
    if (el.dataset.pickerWired) return;
    el.dataset.pickerWired = '1';
    const open = () => {
      try {
        if (typeof el.showPicker === 'function') el.showPicker();
      } catch (_) {
        /* ignore — some browsers only allow showPicker from direct user gesture */
      }
    };
    el.addEventListener('click', open);
    el.addEventListener('focus', open);
  });

  const checkin = document.getElementById('nb_checkin');
  const checkout = document.getElementById('nb_checkout');
  if (checkin && checkout) {
    checkin.addEventListener('change', () => {
      checkout.min = checkin.value || checkout.min;
      if (checkout.value && checkout.value < checkin.value) checkout.value = checkin.value;
    });
  }
}

document.getElementById('modal').onclick = (e) => {
  if (e.target.id === 'modal') hideModal();
};

async function loadPage(page) {
  currentPage = page;
  const titles = {
    dashboard: 'Dashboard',
    guests: 'Guests',
    bookings: 'Bookings',
    rooms: 'Rooms',
    conversations: 'Conversations',
    orders: 'Food Orders',
    requests: 'Service Requests',
    menu: 'Menu Management',
    faq: 'FAQ Management',
  };
  document.getElementById('pageTitle').textContent = titles[page] || page;
  const content = document.getElementById('content');
  content.innerHTML = '<p style="color:var(--muted)">Loading...</p>';

  try {
    switch (page) {
      case 'dashboard': return renderDashboard(content);
      case 'guests': return renderGuests(content);
      case 'bookings': return renderBookings(content);
      case 'rooms': return renderRooms(content);
      case 'conversations': return renderConversations(content);
      case 'orders': return renderOrders(content);
      case 'requests': return renderRequests(content);
      case 'menu': return renderMenu(content);
      case 'faq': return renderFaq(content);
    }
  } catch (err) {
    content.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

async function renderDashboard(el) {
  const stats = await api('/dashboard');
    el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="label">Active Guests</div><div class="value">${stats.active_guests}</div></div>
      <div class="stat-card"><div class="label">Today's Orders</div><div class="value">${stats.today_orders}</div></div>
      <div class="stat-card"><div class="label">Pending Requests</div><div class="value">${stats.pending_requests}</div></div>
      <div class="stat-card"><div class="label">Completed Requests</div><div class="value">${stats.completed_requests}</div></div>
      <div class="stat-card"><div class="label">Open Maintenance</div><div class="value">${stats.maintenance_open}</div></div>
    </div>
    <p class="hint-text">Refresh to see the latest orders and service requests from WhatsApp guests.</p>`;
}

async function renderGuests(el) {
  const guests = await api('/guests');
  el.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Guest</th><th>Phone</th><th>Room</th><th>Booking</th><th>Check-in</th><th>Check-out</th><th>Status</th></tr></thead>
        <tbody>${guests.map((g) => `
          <tr>
            <td>${g.guest_name}</td>
            <td>${g.guest_phone}</td>
            <td>${g.room_number}</td>
            <td>${g.booking_ref}</td>
            <td>${formatDate(g.check_in_date)}</td>
            <td>${formatDate(g.check_out_date)}</td>
            <td>${badge(g.status)}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty-state">No active guests</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

async function renderBookings(el) {
  const bookings = await api('/bookings');
  el.innerHTML = `
    <div class="toolbar">
      <div class="filters">
        ${['all','booked','checked_in','checked_out','cancelled'].map((f) =>
          `<button class="filter-btn ${currentFilter===f?'active':''}" onclick="setBookingFilter('${f}')">${f.replace(/_/g,' ')}</button>`
        ).join('')}
      </div>
      <button class="btn btn-sm btn-primary" onclick="showNewBookingModal()">+ New Booking</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Ref</th><th>Guest</th><th>Phone</th><th>Room</th><th>Check-in</th><th>Check-out</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="bookingsBody"></tbody>
      </table>
    </div>`;
  window._bookings = bookings;
  filterBookings();
}

window.setBookingFilter = (f) => { currentFilter = f; filterBookings(); };
function filterBookings() {
  const filtered = currentFilter === 'all' ? window._bookings : window._bookings.filter((b) => b.status === currentFilter);
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('active', b.textContent.trim().replace(/ /g,'_') === currentFilter || (currentFilter==='all' && b.textContent.trim()==='all')));
  document.getElementById('bookingsBody').innerHTML = filtered.map((b) => `
    <tr>
      <td>${b.booking_ref}</td>
      <td>${b.guest_name}</td>
      <td>${b.guest_phone}</td>
      <td>${b.room_number}</td>
      <td>${formatDate(b.check_in_date)}</td>
      <td>${formatDate(b.check_out_date)}</td>
      <td>${badge(b.status)}</td>
      <td class="actions">
        ${b.status === 'booked' ? `<button class="btn btn-sm btn-success" onclick="updateBookingStatus(${b.id},'checked_in')">Check In</button>` : ''}
        ${b.status === 'checked_in' ? `<button class="btn btn-sm btn-warning" onclick="updateBookingStatus(${b.id},'checked_out')">Check Out</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="8">No bookings</td></tr>';
}

window.updateBookingStatus = async (id, status) => {
  await api(`/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  loadPage('bookings');
};

window.showNewBookingModal = async () => {
  const rooms = await api('/rooms');
  const today = new Date().toISOString().slice(0, 10);
  showModal(`
    <h3>New Booking</h3>
    <div class="form-group"><label>Guest Name</label><input id="nb_name"></div>
    <div class="form-group"><label>Phone (with country code)</label><input id="nb_phone" placeholder="919660888489"></div>
    <div class="form-group"><label>Room</label>
      <select id="nb_room">${rooms.map((r) => `<option value="${r.id}">${r.room_number} (${r.room_type})</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label>Check-in</label>
      <input type="date" id="nb_checkin" class="date-input" value="${today}" min="${today}">
    </div>
    <div class="form-group">
      <label>Check-out</label>
      <input type="date" id="nb_checkout" class="date-input" min="${today}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createBooking()">Create</button>
    </div>`);
  wireDatePickers();
};

window.createBooking = async () => {
  await api('/bookings', {
    method: 'POST',
    body: JSON.stringify({
      guest_name: document.getElementById('nb_name').value,
      guest_phone: document.getElementById('nb_phone').value,
      room_id: parseInt(document.getElementById('nb_room').value),
      check_in_date: document.getElementById('nb_checkin').value,
      check_out_date: document.getElementById('nb_checkout').value,
      status: 'booked',
    }),
  });
  hideModal();
  loadPage('bookings');
};

async function renderRooms(el) {
  const rooms = await api('/rooms');
  el.innerHTML = `
    <div class="toolbar"><button class="btn btn-sm btn-primary" onclick="showNewRoomModal()">+ Add Room</button></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Room</th><th>Floor</th><th>Type</th><th>Status</th><th>Current Guest</th></tr></thead>
        <tbody>${rooms.map((r) => `
          <tr>
            <td>${r.room_number}</td>
            <td>${r.floor || '-'}</td>
            <td>${r.room_type}</td>
            <td>${badge(r.status)}</td>
            <td>${r.guest_name || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

window.showNewRoomModal = () => {
  showModal(`
    <h3>Add Room</h3>
    <div class="form-group"><label>Room Number</label><input id="nr_number"></div>
    <div class="form-group"><label>Floor</label><input type="number" id="nr_floor"></div>
    <div class="form-group"><label>Type</label><select id="nr_type"><option>standard</option><option>deluxe</option><option>suite</option></select></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createRoom()">Add</button>
    </div>`);
};

window.createRoom = async () => {
  await api('/rooms', {
    method: 'POST',
    body: JSON.stringify({
      room_number: document.getElementById('nr_number').value,
      floor: parseInt(document.getElementById('nr_floor').value) || null,
      room_type: document.getElementById('nr_type').value,
    }),
  });
  hideModal();
  loadPage('rooms');
};

async function renderOrders(el) {
  const orders = await api('/orders' + (currentFilter !== 'all' ? `?status=${currentFilter}` : ''));
  el.innerHTML = `
    <div class="filters">
      ${['all','pending','accepted','preparing','out_for_delivery','delivered','rejected'].map((f) =>
        `<button class="filter-btn ${currentFilter===f?'active':''}" onclick="setOrderFilter('${f}')">${f.replace(/_/g,' ')}</button>`
      ).join('')}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Order</th><th>Room</th><th>Guest</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${orders.map((o) => `
          <tr>
            <td><strong>${o.order_ref}</strong><br><small style="color:var(--muted)">${formatDate(o.created_at)} ${formatTime(o.created_at)}</small></td>
            <td>${o.room_number}</td>
            <td>${o.guest_name}</td>
            <td>${(o.items||[]).map((i) => `${i.item_name} ×${i.quantity}`).join('<br>')}</td>
            <td>₹${parseFloat(o.total_amount).toFixed(0)}</td>
            <td>${badge(o.status)}</td>
            <td class="actions">${orderActions(o)}</td>
          </tr>`).join('') || '<tr><td colspan="7">No orders</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

function orderActions(o) {
  // Admin "accepted" = confirm → guest cancel/edit locks after this
  const actions = {
    pending: ['accepted'],
    accepted: ['preparing'],
    preparing: ['out_for_delivery'],
    out_for_delivery: ['delivered'],
  };
  const labels = { accepted: 'Confirm Order' };
  return (actions[o.status] || []).map((s) =>
    `<button class="btn btn-sm btn-success" onclick="updateOrderStatus(${o.id},'${s}')">${labels[s] || s.replace(/_/g, ' ')}</button>`
  ).join('');
}

window.setOrderFilter = (f) => { currentFilter = f; loadPage('orders'); };
window.updateOrderStatus = async (id, status) => {
  await api(`/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  loadPage('orders');
};

async function renderRequests(el) {
  const requests = await api('/requests' + (currentFilter !== 'all' ? `?status=${currentFilter}` : ''));
  el.innerHTML = `
    <div class="filters">
      ${['all','pending','accepted','in_progress','done','rejected'].map((f) =>
        `<button class="filter-btn ${currentFilter===f?'active':''}" onclick="setRequestFilter('${f}')">${f.replace(/_/g,' ')}</button>`
      ).join('')}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Room</th><th>Guest</th><th>Type</th><th>Details</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${requests.map((r) => `
          <tr>
            <td><strong>${r.request_ref}</strong></td>
            <td>${r.room_number}</td>
            <td>${r.guest_name}</td>
            <td>${r.type.replace(/_/g,' ')}${r.sub_type ? '<br><small>'+r.sub_type+'</small>' : ''}</td>
            <td>${r.description || '-'}</td>
            <td>${badge(r.priority)}</td>
            <td>${badge(r.status)}</td>
            <td class="actions">${requestActions(r)}</td>
          </tr>`).join('') || '<tr><td colspan="8">No requests</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

function requestActions(r) {
  const actions = {
    pending: ['accepted','rejected'],
    accepted: ['in_progress','rejected'],
    in_progress: ['done','rejected'],
  };
  return (actions[r.status] || []).map((s) =>
    `<button class="btn btn-sm btn-${s==='rejected'?'danger':'success'}" onclick="updateRequestStatus(${r.id},'${s}')">${s.replace(/_/g,' ')}</button>`
  ).join('');
}

window.setRequestFilter = (f) => { currentFilter = f; loadPage('requests'); };
window.updateRequestStatus = async (id, status) => {
  await api(`/requests/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  loadPage('requests');
};

async function renderConversations(el) {
  const conversations = await api('/conversations');
  el.innerHTML = `
    <div class="chat-layout">
      <div class="chat-list" id="chatList">
        ${conversations.map((c) => `
          <div class="chat-item ${selectedChatPhone===c.guest_phone?'active':''}" onclick="selectChat('${c.guest_phone}','${c.guest_name||''}','${c.room_number||''}')">
            <div class="name">${c.guest_name || c.guest_phone}${c.room_number ? ' — Room '+c.room_number : ''}</div>
            <div class="preview">${c.last_message || ''}</div>
          </div>`).join('') || '<div class="empty-state">No conversations yet</div>'}
      </div>
      <div class="chat-panel">
        <div class="chat-messages" id="chatMessages"><div class="empty-state">Select a conversation</div></div>
        <div class="chat-input hidden" id="chatInput">
          <input type="text" id="msgInput" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendChatMessage()">
          <button class="btn btn-primary btn-sm" onclick="sendChatMessage()">Send</button>
        </div>
      </div>
    </div>`;
  if (selectedChatPhone) selectChat(selectedChatPhone);
}

window.selectChat = async (phone, name, room) => {
  selectedChatPhone = phone;
  document.getElementById('chatInput').classList.remove('hidden');
  const messages = await api(`/conversations/${phone}`);
  const el = document.getElementById('chatMessages');
  el.innerHTML = messages.map((m) => `
    <div class="msg msg-${m.direction === 'inbound' ? 'inbound' : 'outbound'}">
      ${m.content}
      <div class="msg-time">${formatDate(m.created_at)} ${formatTime(m.created_at)}</div>
    </div>`).join('') || '<div class="empty-state">No messages</div>';
  el.scrollTop = el.scrollHeight;
};

window.sendChatMessage = async () => {
  const input = document.getElementById('msgInput');
  const message = input.value.trim();
  if (!message || !selectedChatPhone) return;
  await api('/conversations/send', { method: 'POST', body: JSON.stringify({ phone: selectedChatPhone, message }) });
  input.value = '';
  selectChat(selectedChatPhone);
};

function menuItemThumb(url, name) {
  if (!url) {
    return '<span class="menu-thumb menu-thumb-empty" aria-hidden="true">🍽</span>';
  }
  return `<img class="menu-thumb" src="${escapeHtml(url)}" alt="${escapeHtml(name || 'Item')}" loading="lazy" onerror="this.outerHTML='<span class=&quot;menu-thumb menu-thumb-empty&quot;>—</span>'">`;
}

function menuImagePreviewHtml(url) {
  const src = (url || '').trim();
  if (!src) {
    return '<div class="menu-preview menu-preview-empty">No image</div>';
  }
  return `<img class="menu-preview" src="${escapeHtml(src)}" alt="Preview" onerror="this.outerHTML='<div class=&quot;menu-preview menu-preview-empty&quot;>Image failed to load</div>'">`;
}

async function renderMenu(el) {
  const { categories, items } = await api('/menu');
  window._menuCategories = categories;
  window._menuItems = items;
  el.innerHTML = `
    <div class="toolbar">
      <button class="btn btn-sm btn-primary" onclick="showNewItemModal()">+ Add Item</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Item</th><th>Category</th><th>Meal</th><th>Price</th><th>Available</th><th>Actions</th></tr></thead>
        <tbody>${items.map((i) => `
          <tr>
            <td>
              <div class="menu-item-cell">
                ${menuItemThumb(i.image_url, i.name)}
                <span>${escapeHtml(i.name)}</span>
              </div>
            </td>
            <td>${escapeHtml(i.category_name)}</td>
            <td>${escapeHtml(i.meal_type)}</td>
            <td>₹${parseFloat(i.price).toFixed(0)}</td>
            <td>${i.is_available ? '✅' : '❌'}</td>
            <td class="actions">
              <button class="btn btn-sm btn-primary" onclick="showEditItemModal(${i.id})">Edit</button>
              <button class="btn btn-sm btn-ghost" onclick="toggleItemAvailability(${i.id},${i.is_available?0:1})">${i.is_available?'Disable':'Enable'}</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

window.toggleItemAvailability = async (id, val) => {
  await api(`/menu/items/${id}`, { method: 'PATCH', body: JSON.stringify({ is_available: val }) });
  loadPage('menu');
};

function wireMenuImagePreview() {
  const input = document.getElementById('mi_image');
  const preview = document.getElementById('mi_preview');
  if (!input || !preview) return;
  const update = () => {
    preview.innerHTML = menuImagePreviewHtml(input.value);
  };
  input.addEventListener('input', update);
  input.addEventListener('change', update);
  update();
}

window.showNewItemModal = () => {
  const cats = window._menuCategories || [];
  showModal(`
    <h3>Add Menu Item</h3>
    <div class="form-group"><label>Name</label><input id="mi_name"></div>
    <div class="form-group"><label>Category</label>
      <select id="mi_cat">${cats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.meal_type)})</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>Price (₹)</label><input type="number" id="mi_price"></div>
    <div class="form-group"><label>Image URL (optional)</label><input id="mi_image" placeholder="https://..."></div>
    <div id="mi_preview" class="menu-preview-wrap"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createMenuItem()">Add</button>
    </div>`);
  wireMenuImagePreview();
};

window.showEditItemModal = (id) => {
  const item = (window._menuItems || []).find((i) => i.id === id);
  if (!item) return;
  const cats = window._menuCategories || [];
  showModal(`
    <h3>Edit Menu Item</h3>
    <div class="form-group"><label>Name</label><input id="mi_name" value="${escapeHtml(item.name)}"></div>
    <div class="form-group"><label>Category</label>
      <select id="mi_cat">${cats.map((c) =>
        `<option value="${c.id}" ${c.id === item.category_id ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.meal_type)})</option>`
      ).join('')}</select>
    </div>
    <div class="form-group"><label>Price (₹)</label><input type="number" id="mi_price" value="${parseFloat(item.price)}"></div>
    <div class="form-group"><label>Image URL</label><input id="mi_image" value="${escapeHtml(item.image_url || '')}" placeholder="https://..."></div>
    <div id="mi_preview" class="menu-preview-wrap"></div>
    <div class="form-group"><label>Available</label>
      <select id="mi_available">
        <option value="1" ${item.is_available ? 'selected' : ''}>Yes</option>
        <option value="0" ${!item.is_available ? 'selected' : ''}>No</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveMenuItem(${id})">Save</button>
    </div>`);
  wireMenuImagePreview();
};

window.createMenuItem = async () => {
  await api('/menu/items', {
    method: 'POST',
    body: JSON.stringify({
      name: document.getElementById('mi_name').value,
      category_id: parseInt(document.getElementById('mi_cat').value),
      price: parseFloat(document.getElementById('mi_price').value),
      image_url: document.getElementById('mi_image').value || null,
    }),
  });
  hideModal();
  loadPage('menu');
};

window.saveMenuItem = async (id) => {
  await api(`/menu/items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: document.getElementById('mi_name').value,
      category_id: parseInt(document.getElementById('mi_cat').value),
      price: parseFloat(document.getElementById('mi_price').value),
      image_url: document.getElementById('mi_image').value || null,
      is_available: parseInt(document.getElementById('mi_available').value, 10),
    }),
  });
  hideModal();
  loadPage('menu');
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function renderFaq(el) {
  const faqs = await api('/faqs');
  window._faqs = faqs;
  el.innerHTML = `
    <div class="toolbar"><button class="btn btn-sm btn-primary" onclick="showNewFaqModal()">+ Add FAQ</button></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Question</th><th>Answer</th><th>Keywords</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>${faqs.map((f) => `
          <tr>
            <td>${f.question}</td>
            <td style="max-width:300px">${f.answer}</td>
            <td>${f.keywords || '-'}</td>
            <td>${f.is_active ? '✅' : '❌'}</td>
            <td class="actions">
              <button class="btn btn-sm btn-primary" onclick="showEditFaqModal(${f.id})">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="deleteFaq(${f.id})">Delete</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

window.showNewFaqModal = () => {
  showModal(`
    <h3>Add FAQ</h3>
    <div class="form-group"><label>Question</label><input id="fq_q"></div>
    <div class="form-group"><label>Answer</label><textarea id="fq_a" rows="3"></textarea></div>
    <div class="form-group"><label>Keywords</label><input id="fq_k" placeholder="wifi password internet"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createFaq()">Add</button>
    </div>`);
};

window.showEditFaqModal = (id) => {
  const faq = (window._faqs || []).find((f) => f.id === id);
  if (!faq) return;
  showModal(`
    <h3>Edit FAQ</h3>
    <div class="form-group"><label>Question</label><input id="fq_q" value="${escapeHtml(faq.question)}"></div>
    <div class="form-group"><label>Answer</label><textarea id="fq_a" rows="3">${escapeHtml(faq.answer)}</textarea></div>
    <div class="form-group"><label>Keywords</label><input id="fq_k" value="${escapeHtml(faq.keywords || '')}"></div>
    <div class="form-group"><label>Active</label>
      <select id="fq_active">
        <option value="1" ${faq.is_active ? 'selected' : ''}>Yes</option>
        <option value="0" ${!faq.is_active ? 'selected' : ''}>No</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveFaq(${id})">Save</button>
    </div>`);
};

window.createFaq = async () => {
  await api('/faqs', {
    method: 'POST',
    body: JSON.stringify({
      question: document.getElementById('fq_q').value,
      answer: document.getElementById('fq_a').value,
      keywords: document.getElementById('fq_k').value,
    }),
  });
  hideModal();
  loadPage('faq');
};

window.saveFaq = async (id) => {
  await api(`/faqs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      question: document.getElementById('fq_q').value,
      answer: document.getElementById('fq_a').value,
      keywords: document.getElementById('fq_k').value,
      is_active: parseInt(document.getElementById('fq_active').value, 10),
    }),
  });
  hideModal();
  loadPage('faq');
};

window.deleteFaq = async (id) => {
  if (!confirm('Delete this FAQ?')) return;
  await api(`/faqs/${id}`, { method: 'DELETE' });
  loadPage('faq');
};

loadPage('dashboard');
