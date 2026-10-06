/* ========================
   PLK Bumi Damai — Application Logic
   ======================== */

(function () {
    'use strict';

    // ====== Constants & Supabase Setup ======
    const TARGET_HOURS = 272;
    const STORAGE_KEY = 'plk_tracker_activities';
    const PROFILE_STORAGE_KEY = 'plk_tracker_profile';

    // ====== SUPABASE SETUP ======
    // Isi dari Dashboard Supabase → Project Settings → API:
    //   SUPABASE URL      : https://xxxxx.supabase.co
    //   SUPABASE ANON KEY : eyJhbGciOi... (anon public, BUKAN service role)
    // Jalankan dulu supabase-setup.sql di SQL Editor sebelum dipakai.
    // Selama masih placeholder, aplikasi jalan mode lokal (localStorage).
    const SUPABASE_URL = 'https://lxvtqgsyzideeqavfiit.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_HguapeGQ2OHiSw6EoqATDg_CHIUZIS2';
    const PHOTO_BUCKET = 'activity-photos';
    const MIGRATED_KEY = 'plk_tracker_migrated_v1';

    const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
        'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const DAYS_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
    const CATEGORY_LABELS = {
        'pre-acara': 'Pre-acara',
        'pra-acara': 'Pra-acara',
        'hari-h': 'Hari-H',
        'pasca-acara': 'Pra-acara'
    };
    const CATEGORY_COLORS = {
        'pre-acara': '#fcb527',
        'hari-h': '#69ac43',
        'pra-acara': '#50abe4',
        'pasca-acara': '#9e89d6'
    };
    const cssVar = (name, fallback) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

    // ====== Supabase Client ======
    function isSupabaseConfigured() {
        return Boolean(
            window.supabase &&
            SUPABASE_URL && !SUPABASE_URL.includes('YOUR_PROJECT_ID') &&
            SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE_ANON_KEY')
        );
    }

    function getSupabase() {
        if (!isSupabaseConfigured()) return null;
        if (!window._supabaseClient) {
            window._supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        }
        return window._supabaseClient;
    }

    // ====== Mapping: baris Supabase ↔ objek aplikasi ======
    function rowToActivity(row) {
        return {
            id: row.id,
            name: row.name,
            date: typeof row.date === 'string' ? row.date : String(row.date).slice(0, 10),
            category: row.category,
            startTime: row.start_time || '',
            endTime: row.end_time || '',
            hours: Number(row.hours) || 0,
            description: row.description || '',
            photos: row.photos || [],
            createdAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
            updatedAt: row.updated_at ? Date.parse(row.updated_at) : Date.now()
        };
    }

    function activityToRow(act) {
        return {
            id: act.id,
            name: act.name,
            date: act.date,
            category: act.category,
            start_time: act.startTime || null,
            end_time: act.endTime || null,
            hours: act.hours,
            description: act.description || '',
            photos: act.photos || [],
            created_at: act.createdAt ? new Date(act.createdAt).toISOString() : new Date().toISOString(),
            updated_at: act.updatedAt ? new Date(act.updatedAt).toISOString() : new Date().toISOString()
        };
    }

    // ====== Supabase Storage: foto bukti ======
    function isDataUrl(value) {
        return typeof value === 'string' && value.startsWith('data:');
    }

    // "https://xxx.supabase.co/storage/v1/object/public/activity-photos/act_1/pic.jpg"
    //  → "act_1/pic.jpg"
    function photoPathFromUrl(url) {
        if (typeof url !== 'string') return null;
        const marker = `/object/public/${PHOTO_BUCKET}/`;
        const idx = url.indexOf(marker);
        if (idx === -1) return null;
        return decodeURIComponent(url.slice(idx + marker.length).split('?')[0]);
    }

    async function uploadPhoto(activityId, dataUrl) {
        const client = getSupabase();
        if (!client) throw new Error('Supabase belum disetel');
        const blob = await (await fetch(dataUrl)).blob();
        const path = `${activityId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error } = await client.storage
            .from(PHOTO_BUCKET)
            .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (error) throw error;
        return client.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
    }

    async function removePhotos(urls) {
        const client = getSupabase();
        if (!client || !Array.isArray(urls) || urls.length === 0) return;
        const paths = urls.map(photoPathFromUrl).filter(Boolean);
        if (paths.length === 0) return;
        try {
            const { error } = await client.storage.from(PHOTO_BUCKET).remove(paths);
            if (error) throw error;
        } catch (e) {
            console.warn('Foto gagal dihapus dari Storage:', e);
        }
    }

    /**
     * Sinkronisasi foto saat menyimpan:
     * - foto lama yang dibuang pengguna → dihapus dari Storage
     * - foto baru (dataURL) → di-upload, diganti URL publiknya
     * - foto lama yang masih dipakai → dibiarkan
     * Bila Supabase belum disetel, foto tetap dataURL (mode lokal).
     */
    async function syncPhotos(activityId, oldPhotos, workingPhotos) {
        const client = getSupabase();
        if (!client) return [...workingPhotos];

        const removed = (oldPhotos || []).filter(p => !workingPhotos.includes(p));
        if (removed.length) await removePhotos(removed);

        const result = [];
        for (const photo of workingPhotos) {
            result.push(isDataUrl(photo) ? await uploadPhoto(activityId, photo) : photo);
        }
        return result;
    }

    // ====== Tulis 1 kegiatan ke Supabase (no-op bila belum disetel) ======
    async function persistActivity(activity) {
        const client = getSupabase();
        if (!client) return;
        const { error } = await client
            .from('activities')
            .upsert(activityToRow(activity), { onConflict: 'id' });
        if (error) throw error;
    }

    // ====== State ======
    let activities = [];
    let currentCalMonth = new Date().getMonth();
    let currentCalYear = new Date().getFullYear();
    let editingId = null;
    let deleteTargetId = null;
    let photoDataUrls = [];

    // ====== DOM Elements ======
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ====== Init ======
    function init() {
        loadActivities();
        loadProfile();
        injectSVGGradient();
        bindEvents();
        bindProfileEvents();
        renderAll();
        renderProfile();
        setDefaultDate();
    }

    // ====== SVG Gradient for Ring ======
    function injectSVGGradient() {
        const svg = document.querySelector('.progress-ring');
        if (!svg) return;
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        grad.setAttribute('id', 'ring-gradient');
        grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
        grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '100%');
        const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop1.setAttribute('offset', '0%');
        stop1.setAttribute('stop-color', '#2D8F5E');
        const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop2.setAttribute('offset', '50%');
        stop2.setAttribute('stop-color', '#50ABE4');
        const stop3 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop3.setAttribute('offset', '100%');
        stop3.setAttribute('stop-color', '#9E89D6');
        grad.appendChild(stop1);
        grad.appendChild(stop2);
        grad.appendChild(stop3);
        defs.appendChild(grad);
        svg.insertBefore(defs, svg.firstChild);
    }

    // ====== Storage (Supabase Cloud + LocalStorage Fallback) ======
    function readLocalActivities() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    // Migrasi sekali jalan: data lama di localStorage → Supabase
    // (foto dataURL ikut di-upload ke Storage). Return false bila gagal,
    // supaya koneksi berikutnya bisa mencoba lagi.
    async function migrateLocalActivities(client, local) {
        try {
            if (local.length > 0) {
                local.forEach(act => { if (!act.id) act.id = generateId(); });
                for (const act of local) {
                    if (Array.isArray(act.photos) && act.photos.some(isDataUrl)) {
                        act.photos = await syncPhotos(act.id, [], act.photos);
                    }
                }
                const { error } = await client
                    .from('activities')
                    .upsert(local.map(activityToRow), { onConflict: 'id' });
                if (error) throw error;
            }
            localStorage.setItem(MIGRATED_KEY, '1');
            return true;
        } catch (e) {
            console.warn('Migrasi localStorage → Supabase gagal (akan dicoba lagi):', e);
            return false;
        }
    }

    async function loadActivities() {
        const client = getSupabase();
        if (client) {
            try {
                const { data, error } = await client
                    .from('activities')
                    .select('*')
                    .order('date', { ascending: false });
                if (!error && data) {
                    // Koneksi pertama & cloud masih kosong → dorong data lokal
                    if (data.length === 0 && !localStorage.getItem(MIGRATED_KEY)) {
                        const local = readLocalActivities();
                        const ok = await migrateLocalActivities(client, local);
                        activities = local;
                        if (ok) saveActivities();
                        renderAll();
                        return;
                    }
                    activities = data.map(rowToActivity);
                    saveActivities(); // mirror lokal sebagai fallback offline
                    renderAll();
                    return;
                }
                console.warn('Supabase error, fallback ke localStorage:', error);
            } catch (e) {
                console.warn('Supabase tidak terjangkau, fallback ke localStorage:', e);
            }
        }
        activities = readLocalActivities();
        renderAll(); // render di sini penting: bila fetch Supabase gagal async,
        // renderAll() awal di init() sudah terlanjur jalan dengan data kosong
    }

    function saveActivities() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(activities));
    }

    // ====== Events ======
    function bindEvents() {
        // Navigation
        $$('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                navigateTo(item.dataset.page);
            });
        });

        // Add Activity buttons
        $('#btn-add-activity').addEventListener('click', openAddModal);
        $('#btn-add-activity-2').addEventListener('click', openAddModal);
        $('#add-btn-mobile').addEventListener('click', openAddModal);

        // Modal controls
        $('#modal-close').addEventListener('click', closeModal);
        $('#btn-cancel').addEventListener('click', closeModal);
        $('#modal-overlay').addEventListener('click', (e) => {
            if (e.target === $('#modal-overlay')) closeModal();
        });

        // Form submission
        $('#activity-form').addEventListener('submit', handleFormSubmit);

        // Time auto-calc
        $('#activity-start').addEventListener('change', calcDuration);
        $('#activity-end').addEventListener('change', calcDuration);

        // Photo upload
        const photoUpload = $('#photo-upload');
        const photoInput = $('#activity-photo');

        photoUpload.addEventListener('click', (e) => {
            if (e.target.closest('.photo-preview-remove')) return;
            photoInput.click();
        });
        photoInput.addEventListener('change', handlePhotoSelect);

        photoUpload.addEventListener('dragover', (e) => {
            e.preventDefault();
            photoUpload.classList.add('dragover');
        });
        photoUpload.addEventListener('dragleave', () => {
            photoUpload.classList.remove('dragover');
        });
        photoUpload.addEventListener('drop', (e) => {
            e.preventDefault();
            photoUpload.classList.remove('dragover');
            handleDroppedFiles(e.dataTransfer.files);
        });

        // Delete modal
        $('#delete-cancel').addEventListener('click', (e) => {
            e.preventDefault();
            closeDeleteModal();
        });
        $('#delete-confirm').addEventListener('click', (e) => {
            e.preventDefault();
            confirmDelete();
        });
        $('#delete-modal-overlay').addEventListener('click', (e) => {
            if (e.target === $('#delete-modal-overlay')) closeDeleteModal();
        });

        // Delete button inside edit modal
        const deleteInModalBtn = $('#btn-delete-in-modal');
        if (deleteInModalBtn) {
            deleteInModalBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (editingId) {
                    openDeleteModal(editingId);
                }
            });
        }

        // Lightbox
        $('#lightbox').addEventListener('click', closeLightbox);
        $('#lightbox-close').addEventListener('click', closeLightbox);

        // Calendar nav
        $('#cal-prev').addEventListener('click', () => { currentCalMonth--; if (currentCalMonth < 0) { currentCalMonth = 11; currentCalYear--; } renderCalendar(); });
        $('#cal-next').addEventListener('click', () => { currentCalMonth++; if (currentCalMonth > 11) { currentCalMonth = 0; currentCalYear++; } renderCalendar(); });

        // Search & Filter
        $('#search-input').addEventListener('input', renderActivitiesList);
        $('#filter-category').addEventListener('change', renderActivitiesList);

        // Link all activities
        $('#link-all-activities').addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo('activities');
        });

        // Mobile menu
        $('#menu-toggle').addEventListener('click', toggleMobileSidebar);

        // ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeModal();
                closeDeleteModal();
                closeLightbox();
                closeMobileSidebar();
            }
        });
    }

    // ====== Navigation ======
    function navigateTo(page) {
        $$('.nav-item').forEach(n => n.classList.remove('active'));
        $(`.nav-item[data-page="${page}"]`).classList.add('active');
        $$('.page').forEach(p => p.classList.remove('active'));
        $(`#page-${page}`).classList.add('active');
        closeMobileSidebar();

        if (page === 'calendar') renderCalendar();
        if (page === 'gallery') renderGallery();
        if (page === 'activities') renderActivitiesList();
    }

    // ====== Mobile Sidebar ======
    function toggleMobileSidebar() {
        const sidebar = $('#sidebar');
        sidebar.classList.toggle('open');
        let overlay = $('.sidebar-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'sidebar-overlay';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', closeMobileSidebar);
        }
        overlay.classList.toggle('active', sidebar.classList.contains('open'));
    }

    function closeMobileSidebar() {
        $('#sidebar').classList.remove('open');
        const overlay = $('.sidebar-overlay');
        if (overlay) overlay.classList.remove('active');
    }

    // ====== Modal ======
    function openAddModal() {
        editingId = null;
        $('#modal-title').textContent = 'Tambah Kegiatan Baru';
        $('#btn-submit').textContent = 'Simpan Kegiatan';
        $('#btn-delete-in-modal').style.display = 'none';
        $('#activity-form').reset();
        $('#edit-id').value = '';
        photoDataUrls = [];
        renderPhotoPreview();
        setDefaultDate();
        $('#modal-overlay').classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function openEditModal(id) {
        const act = activities.find(a => String(a.id) === String(id));
        if (!act) return;
        editingId = id;
        $('#modal-title').textContent = 'Edit Kegiatan';
        $('#btn-submit').textContent = 'Simpan Perubahan';
        $('#btn-delete-in-modal').style.display = 'inline-flex';
        $('#edit-id').value = id;
        $('#activity-name').value = act.name;
        $('#activity-date').value = act.date;
        $('#activity-category').value = act.category;
        $('#activity-start').value = act.startTime || '';
        $('#activity-end').value = act.endTime || '';
        $('#activity-hours').value = act.hours;
        $('#activity-description').value = act.description || '';
        photoDataUrls = act.photos ? [...act.photos] : [];
        renderPhotoPreview();
        $('#modal-overlay').classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeModal() {
        $('#modal-overlay').classList.remove('active');
        document.body.style.overflow = '';
        editingId = null;
        photoDataUrls = [];
    }

    // ====== Delete Logic ======
    function openDeleteModal(id) {
        deleteTargetId = id;
        $('#delete-modal-overlay').classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeDeleteModal() {
        $('#delete-modal-overlay').classList.remove('active');
        document.body.style.overflow = '';
        deleteTargetId = null;
    }

    async function deleteActivity(id) {
        if (!id) return;
        const target = activities.find(a => String(a.id) === String(id));
        try {
            const client = getSupabase();
            if (client) {
                const { error } = await client
                    .from('activities')
                    .delete()
                    .eq('id', id);
                if (error) throw error;
                if (target && target.photos && target.photos.length) {
                    await removePhotos(target.photos);
                }
            }
            activities = activities.filter(a => String(a.id) !== String(id));
            saveActivities();
            closeModal();
            closeDeleteModal();
            renderAll();
            showToast('Kegiatan berhasil dihapus!', 'success');
        } catch (err) {
            console.error('Gagal menghapus kegiatan:', err);
            showToast('Gagal menghapus: ' + (err.message || err), 'error');
        }
    }

    function confirmDelete() {
        if (deleteTargetId) {
            deleteActivity(deleteTargetId);
        } else {
            closeDeleteModal();
        }
    }

    // ====== Lightbox ======
    function openLightbox(src) {
        $('#lightbox-img').src = src;
        $('#lightbox').classList.add('active');
    }

    function closeLightbox() {
        $('#lightbox').classList.remove('active');
    }

    // ====== Duration Calc ======
    function calcDuration() {
        const start = $('#activity-start').value;
        const end = $('#activity-end').value;
        if (start && end) {
            const [sh, sm] = start.split(':').map(Number);
            const [eh, em] = end.split(':').map(Number);
            let diff = (eh * 60 + em) - (sh * 60 + sm);
            if (diff < 0) diff += 24 * 60;
            const hours = Math.round(diff / 30) * 0.5; // round to nearest 0.5
            $('#activity-hours').value = hours > 0 ? hours : 0.5;
        }
    }

    function setDefaultDate() {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        $('#activity-date').value = `${yyyy}-${mm}-${dd}`;
    }

    // ====== Photo Handling ======
    function handlePhotoSelect(e) {
        const files = Array.from(e.target.files);
        processPhotoFiles(files);
    }

    function handleDroppedFiles(files) {
        const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        processPhotoFiles(imageFiles);
    }

    function processPhotoFiles(files) {
        const maxPhotos = 5;
        const remaining = maxPhotos - photoDataUrls.length;
        const toProcess = files.slice(0, remaining);

        toProcess.forEach(file => {
            const reader = new FileReader();
            reader.onload = (e) => {
                // Resize image to save localStorage space
                resizeImage(e.target.result, 800, (resized) => {
                    photoDataUrls.push(resized);
                    renderPhotoPreview();
                });
            };
            reader.readAsDataURL(file);
        });
    }

    function resizeImage(dataUrl, maxDim, callback) {
        const img = new Image();
        img.onload = () => {
            let w = img.width;
            let h = img.height;
            if (w > maxDim || h > maxDim) {
                if (w > h) {
                    h = Math.round(h * maxDim / w);
                    w = maxDim;
                } else {
                    w = Math.round(w * maxDim / h);
                    h = maxDim;
                }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            callback(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.src = dataUrl;
    }

    function renderPhotoPreview() {
        const list = $('#photo-preview-list');
        const placeholder = $('#photo-placeholder');
        list.innerHTML = '';

        if (photoDataUrls.length === 0) {
            placeholder.style.display = 'flex';
            return;
        }

        placeholder.style.display = 'none';
        photoDataUrls.forEach((url, idx) => {
            const item = document.createElement('div');
            item.className = 'photo-preview-item';
            item.innerHTML = `
                <img src="${url}" alt="Preview ${idx + 1}">
                <button type="button" class="photo-preview-remove" data-idx="${idx}">&times;</button>
            `;
            item.querySelector('.photo-preview-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                photoDataUrls.splice(idx, 1);
                renderPhotoPreview();
            });
            list.appendChild(item);
        });
    }

    // ====== Form Submit ======
    async function handleFormSubmit(e) {
        e.preventDefault();
        const name = $('#activity-name').value.trim();
        const date = $('#activity-date').value;
        const category = $('#activity-category').value;
        const startTime = $('#activity-start').value;
        const endTime = $('#activity-end').value;
        const hours = parseFloat($('#activity-hours').value);
        const description = $('#activity-description').value.trim();

        if (!name || !date || !category || !hours) {
            showToast('Mohon lengkapi semua field wajib', 'error');
            return;
        }

        const submitBtn = $('#btn-submit');
        submitBtn.disabled = true;

        try {
            if (editingId) {
                const idx = activities.findIndex(a => String(a.id) === String(editingId));
                if (idx === -1) throw new Error('Kegiatan tidak ditemukan');
                const prev = activities[idx];
                const photos = await syncPhotos(String(prev.id), prev.photos || [], photoDataUrls);
                const updated = {
                    ...prev,
                    name, date, category, startTime, endTime, hours, description,
                    photos,
                    updatedAt: Date.now()
                };
                await persistActivity(updated);       // upsert ke Supabase (no-op bila lokal)
                activities[idx] = updated;
                showToast('Kegiatan berhasil diperbarui!', 'success');
            } else {
                const id = generateId();
                const photos = await syncPhotos(id, [], photoDataUrls);
                const activity = {
                    id, name, date, category, startTime, endTime, hours, description,
                    photos,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                await persistActivity(activity);      // insert ke Supabase (no-op bila lokal)
                activities.push(activity);
                showToast('Kegiatan berhasil ditambahkan!', 'success');
            }

            saveActivities(); // mirror lokal sebagai fallback offline
            closeModal();
            renderAll();
        } catch (err) {
            console.error('Gagal menyimpan kegiatan:', err);
            showToast('Gagal menyimpan: ' + (err.message || err), 'error');
        } finally {
            submitBtn.disabled = false;
        }
    }

    function generateId() {
        return 'act_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // ====== Toast ======
    function showToast(message, type = 'success') {
        const container = $('#toast-container');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${type === 'success' ? '#69ac43' : '#fb667c'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                ${type === 'success'
                ? '<polyline points="20 6 9 17 4 12"/>'
                : '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'}
            </svg>
            <span class="toast-message">${message}</span>
        `;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    // ====== Render All ======
    function renderAll() {
        try { renderDashboard(); } catch (e) { console.error('Dashboard render error:', e); }
        try { renderActivitiesList(); } catch (e) { console.error('Activities render error:', e); }
        try { renderGallery(); } catch (e) { console.error('Gallery render error:', e); }
        try { renderCalendar(); } catch (e) { console.error('Calendar render error:', e); }
    }

    // ====== Dashboard Render ======
    function renderDashboard() {
        const totalHours = activities.reduce((sum, a) => sum + a.hours, 0);
        const percent = Math.min((totalHours / TARGET_HOURS) * 100, 100);
        const remaining = Math.max(TARGET_HOURS - totalHours, 0);
        const avg = activities.length > 0 ? (totalHours / activities.length).toFixed(1) : '0';

        // Animate progress ring
        const circumference = 2 * Math.PI * 85; // r=85
        const ring = $('#progress-ring-fill');
        if (ring) {
            ring.style.strokeDasharray = circumference;
            setTimeout(() => {
                ring.style.strokeDashoffset = circumference - (percent / 100) * circumference;
            }, 100);
        }

        // Progress text
        animateNumber($('#progress-percent'), percent, '%', 0);
        animateNumber($('#progress-hours'), totalHours, '', 1);

        // Progress bar
        setTimeout(() => {
            $('#progress-bar-fill').style.width = percent + '%';
            $('#sidebar-progress-fill').style.width = percent + '%';
        }, 100);

        // Stats
        $('#stat-remaining').textContent = remaining.toFixed(1);
        $('#stat-activities').textContent = activities.length;
        $('#stat-avg').textContent = avg;
        $('#sidebar-progress-text').textContent = `${totalHours.toFixed(1)} / ${TARGET_HOURS} jam`;

        // Category breakdown
        const hoursByCategory = {
            'pre-acara': 0,
            'hari-h': 0,
            'pra-acara': 0
        };
        activities.forEach(a => {
            let cat = a.category;
            if (cat === 'pasca-acara') cat = 'pra-acara';
            if (hoursByCategory[cat] !== undefined) {
                hoursByCategory[cat] += a.hours;
            }
        });

        if ($('#hours-pre')) $('#hours-pre').textContent = hoursByCategory['pre-acara'].toFixed(1);
        if ($('#hours-hari')) $('#hours-hari').textContent = hoursByCategory['hari-h'].toFixed(1);
        if ($('#hours-pra')) $('#hours-pra').textContent = hoursByCategory['pra-acara'].toFixed(1);

        // Category bars
        const maxCat = Math.max(...Object.values(hoursByCategory), 1);
        setTimeout(() => {
            if ($('#bar-pre')) $('#bar-pre').style.width = (hoursByCategory['pre-acara'] / maxCat * 100) + '%';
            if ($('#bar-hari')) $('#bar-hari').style.width = (hoursByCategory['hari-h'] / maxCat * 100) + '%';
            if ($('#bar-pra')) $('#bar-pra').style.width = (hoursByCategory['pra-acara'] / maxCat * 100) + '%';
        }, 200);

        // Recent activities
        renderRecentActivities();

        // Distribution chart
        renderDistributionChart(hoursByCategory, totalHours);

        // Weekly chart
        renderWeeklyChart();
    }

    function animateNumber(element, target, suffix = '', decimals = 0) {
        if (!element) return;
        const duration = 1000;
        const start = parseFloat(element.textContent) || 0;
        const startTime = performance.now();

        function update(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = start + (target - start) * eased;
            element.textContent = current.toFixed(decimals) + suffix;
            if (progress < 1) requestAnimationFrame(update);
        }

        requestAnimationFrame(update);
    }

    function renderRecentActivities() {
        const container = $('#recent-activities');
        const sorted = [...activities].sort((a, b) => new Date(b.date) - new Date(a.date));
        const recent = sorted.slice(0, 5);

        if (recent.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="18" x2="12" y2="12"/>
                        <line x1="9" y1="15" x2="15" y2="15"/>
                    </svg>
                    <p>Belum ada kegiatan tercatat</p>
                    <span>Klik "Tambah Kegiatan" untuk memulai</span>
                </div>`;
            return;
        }

        container.innerHTML = '';
        recent.forEach(act => {
            const dateObj = new Date(act.date + 'T00:00:00');
            const dateStr = `${dateObj.getDate()} ${MONTHS_ID[dateObj.getMonth()].substring(0, 3)}`;
            const item = document.createElement('div');
            item.className = 'activity-item';
            item.innerHTML = `
                <span class="activity-category-badge badge-${act.category}">${CATEGORY_LABELS[act.category] || 'Kegiatan'}</span>
                <div class="activity-info">
                    <div class="activity-name">${escapeHtml(act.name)}</div>
                    <div class="activity-meta">
                        <span>${dateStr}</span>
                        ${act.startTime ? `<span>${act.startTime} - ${act.endTime}</span>` : ''}
                    </div>
                </div>
                <span class="activity-hours-badge">${act.hours} jam</span>
                ${act.photos && act.photos.length > 0 ? `
                    <div class="activity-photo-indicator">
                        <img src="${act.photos[0]}" alt="Bukti foto" loading="lazy">
                    </div>
                ` : ''}
                <div class="activity-actions">
                    <button class="btn-icon edit-btn" title="Edit">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    <button class="btn-icon delete-btn" title="Hapus">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            `;

            item.querySelector('.edit-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                openEditModal(act.id);
            });
            item.querySelector('.delete-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                openDeleteModal(act.id);
            });

            container.appendChild(item);
        });
    }

    // ====== Distribution Chart (Canvas) ======
    function renderDistributionChart(hoursByCategory, totalHours) {
        const canvas = $('#chart-distribution');
        if (!canvas) return;
        const rect = canvas.parentElement;
        if (!rect) return;
        const dpr = window.devicePixelRatio || 1;
        const clientW = rect.clientWidth > 0 ? rect.clientWidth : 280;
        const size = Math.max(Math.min(clientW - 40, 240), 100);

        canvas.width = size * dpr;
        canvas.height = size * dpr;
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const cx = size / 2;
        const cy = size / 2;
        const radius = Math.max(size / 2 - 20, 10);
        const innerRadius = radius * 0.6;

        ctx.clearRect(0, 0, size, size);

        if (totalHours === 0) {
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.arc(cx, cy, innerRadius, Math.PI * 2, 0, true);
            ctx.fillStyle = 'rgba(45, 143, 94, 0.12)';
            ctx.fill();

            ctx.fillStyle = cssVar('--fg-muted', '#64748b');
            ctx.font = '500 13px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Belum ada data', cx, cy);
        } else {
            const data = [
                { key: 'pre-acara', value: hoursByCategory['pre-acara'], color: CATEGORY_COLORS['pre-acara'] },
                { key: 'hari-h', value: hoursByCategory['hari-h'], color: CATEGORY_COLORS['hari-h'] },
                { key: 'pra-acara', value: hoursByCategory['pra-acara'], color: CATEGORY_COLORS['pra-acara'] }
            ].filter(d => d.value > 0);

            let startAngle = -Math.PI / 2;
            data.forEach(d => {
                const sliceAngle = (d.value / totalHours) * Math.PI * 2;
                ctx.beginPath();
                ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
                ctx.arc(cx, cy, innerRadius, startAngle + sliceAngle, startAngle, true);
                ctx.closePath();
                ctx.fillStyle = d.color;
                ctx.fill();
                startAngle += sliceAngle;
            });

            // Center text
            ctx.fillStyle = cssVar('--fg', '#f1f5f9');
            ctx.font = '800 22px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(totalHours.toFixed(1), cx, cy - 8);
            ctx.fillStyle = cssVar('--fg-muted', '#64748b');
            ctx.font = '500 11px Inter, sans-serif';
            ctx.fillText('Total Jam', cx, cy + 12);
        }

        // Legend
        const legend = $('#chart-legend');
        legend.innerHTML = '';
        [
            { key: 'pre-acara', label: 'Pre-acara', color: CATEGORY_COLORS['pre-acara'] },
            { key: 'hari-h', label: 'Hari-H', color: CATEGORY_COLORS['hari-h'] },
            { key: 'pra-acara', label: 'Pra-acara', color: CATEGORY_COLORS['pra-acara'] }
        ].forEach(item => {
            const val = hoursByCategory[item.key] || 0;
            const pct = totalHours > 0 ? ((val / totalHours) * 100).toFixed(0) : 0;
            const el = document.createElement('div');
            el.className = 'legend-item';
            el.innerHTML = `
                <span class="legend-dot" style="background:${item.color}"></span>
                <span class="legend-label">${item.label}</span>
                <span class="legend-value">${val.toFixed(1)} jam (${pct}%)</span>
            `;
            legend.appendChild(el);
        });
    }

    // ====== Weekly Bar Chart ======
    function renderWeeklyChart() {
        const container = $('#weekly-chart');
        if (activities.length === 0) {
            container.innerHTML = '<div class="empty-state small"><p>Data akan muncul setelah kamu menambah kegiatan</p></div>';
            return;
        }

        // Group by week
        const weekMap = {};
        activities.forEach(a => {
            const d = new Date(a.date + 'T00:00:00');
            const weekStart = getWeekStart(d);
            const key = weekStart.toISOString().split('T')[0];
            if (!weekMap[key]) weekMap[key] = 0;
            weekMap[key] += a.hours;
        });

        const weeks = Object.entries(weekMap)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .slice(-12); // last 12 weeks

        const maxHours = Math.max(...weeks.map(w => w[1]), 1);

        container.innerHTML = '';
        container.style.display = 'flex';

        weeks.forEach(([key, hours]) => {
            const d = new Date(key + 'T00:00:00');
            const label = `${d.getDate()} ${MONTHS_ID[d.getMonth()].substring(0, 3)}`;
            const heightPct = (hours / maxHours) * 100;
            const col = document.createElement('div');
            col.className = 'bar-chart-col';
            col.innerHTML = `
                <div class="bar-chart-bar ${hours > 0 ? 'has-hours' : ''}" style="height:${Math.max(heightPct, 2)}%;background:${hours > 0 ? 'var(--accent-gradient)' : 'rgba(45,143,94,0.12)'}">
                    <span class="bar-chart-bar-tooltip">${hours.toFixed(1)} jam</span>
                </div>
                <span class="bar-chart-label">${label}</span>
            `;
            container.appendChild(col);
        });
    }

    function getWeekStart(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        return d;
    }

    // ====== Activities List ======
    function renderActivitiesList() {
        const container = $('#activities-list');
        const search = ($('#search-input')?.value || '').toLowerCase();
        const filterCat = $('#filter-category')?.value || 'all';

        let filtered = activities.filter(a => {
            const matchSearch = !search || a.name.toLowerCase().includes(search) || (a.description || '').toLowerCase().includes(search);
            const matchCat = filterCat === 'all' || a.category === filterCat;
            return matchSearch && matchCat;
        });

        filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="18" x2="12" y2="12"/>
                        <line x1="9" y1="15" x2="15" y2="15"/>
                    </svg>
                    <p>${search || filterCat !== 'all' ? 'Tidak ada kegiatan ditemukan' : 'Belum ada kegiatan tercatat'}</p>
                    <span>${search || filterCat !== 'all' ? 'Coba ubah filter pencarian' : 'Mulai catat kegiatan pengabdianmu!'}</span>
                </div>`;
            return;
        }

        container.innerHTML = '';
        filtered.forEach(act => {
            const dateObj = new Date(act.date + 'T00:00:00');
            const dayNum = dateObj.getDate();
            const monthStr = MONTHS_ID[dateObj.getMonth()].substring(0, 3);
            const dayName = DAYS_ID[dateObj.getDay()];

            const card = document.createElement('div');
            card.className = 'activity-card';
            card.innerHTML = `
                <div class="activity-date-col">
                    <span class="date-day">${dayNum}</span>
                    <span class="date-month">${monthStr}</span>
                </div>
                <div class="activity-content">
                    <div class="activity-title">${escapeHtml(act.name)}</div>
                    ${act.description ? `<div class="activity-desc">${escapeHtml(act.description)}</div>` : ''}
                    <div class="activity-tags">
                        <span class="activity-category-badge badge-${act.category}">${CATEGORY_LABELS[act.category]}</span>
                        ${act.startTime ? `<span class="time-tag">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            ${act.startTime} - ${act.endTime}
                        </span>` : ''}
                        <span class="hours-tag">${act.hours} jam</span>
                        <span class="time-tag">${dayName}</span>
                    </div>
                </div>
                <div class="photo-thumbs">
                    ${(act.photos || []).slice(0, 3).map(p =>
                `<div class="photo-thumb"><img src="${p}" alt="Bukti foto" loading="lazy"></div>`
            ).join('')}
                </div>
                <div class="card-actions">
                    <button class="btn-icon edit-btn" title="Edit" data-id="${act.id}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    <button class="btn-icon delete-btn" title="Hapus" data-id="${act.id}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            `;

            // Event listeners for card
            card.querySelectorAll('.photo-thumb').forEach(thumb => {
                thumb.addEventListener('click', () => openLightbox(thumb.querySelector('img').src));
            });
            card.querySelector('.edit-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                openEditModal(act.id);
            });
            card.querySelector('.delete-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                openDeleteModal(act.id);
            });

            container.appendChild(card);
        });
    }

    // ====== Gallery ======
    function renderGallery() {
        const container = $('#gallery-grid');
        const allPhotos = [];

        activities.forEach(act => {
            (act.photos || []).forEach(photo => {
                allPhotos.push({
                    src: photo,
                    name: act.name,
                    date: act.date,
                    category: act.category
                });
            });
        });

        if (allPhotos.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column:1/-1">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    <p>Belum ada foto dokumentasi</p>
                    <span>Foto akan muncul saat kamu menambah kegiatan dengan bukti foto</span>
                </div>`;
            return;
        }

        container.innerHTML = '';
        allPhotos.forEach(photo => {
            const dateObj = new Date(photo.date + 'T00:00:00');
            const dateStr = `${dateObj.getDate()} ${MONTHS_ID[dateObj.getMonth()]} ${dateObj.getFullYear()}`;
            const item = document.createElement('div');
            item.className = 'gallery-item';
            item.innerHTML = `
                <img src="${photo.src}" alt="${escapeHtml(photo.name)}" loading="lazy">
                <div class="gallery-item-overlay">
                    <div class="gallery-item-title">${escapeHtml(photo.name)}</div>
                    <div class="gallery-item-date">${dateStr}</div>
                </div>
            `;
            item.addEventListener('click', () => openLightbox(photo.src));
            container.appendChild(item);
        });
    }

    // ====== Calendar ======
    function renderCalendar() {
        const container = $('#calendar-grid');
        $('#cal-month').textContent = `${MONTHS_ID[currentCalMonth]} ${currentCalYear}`;

        container.innerHTML = '';

        // Header
        DAYS_ID.forEach(day => {
            const cell = document.createElement('div');
            cell.className = 'calendar-header-cell';
            cell.textContent = day;
            container.appendChild(cell);
        });

        // Days
        const firstDay = new Date(currentCalYear, currentCalMonth, 1);
        const lastDay = new Date(currentCalYear, currentCalMonth + 1, 0);
        const startDay = firstDay.getDay(); // 0=Sun
        const daysInMonth = lastDay.getDate();
        const prevMonthLastDay = new Date(currentCalYear, currentCalMonth, 0).getDate();

        const today = new Date();

        // Activities indexed by date
        const actByDate = {};
        activities.forEach(a => {
            if (!actByDate[a.date]) actByDate[a.date] = [];
            actByDate[a.date].push(a);
        });

        // Previous month padding
        for (let i = startDay - 1; i >= 0; i--) {
            const cell = document.createElement('div');
            cell.className = 'calendar-cell other-month';
            cell.innerHTML = `<div class="calendar-day">${prevMonthLastDay - i}</div>`;
            container.appendChild(cell);
        }

        // Current month
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${currentCalYear}-${String(currentCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const isToday = today.getFullYear() === currentCalYear && today.getMonth() === currentCalMonth && today.getDate() === d;
            const dayActivities = actByDate[dateStr] || [];

            const cell = document.createElement('div');
            cell.className = `calendar-cell${isToday ? ' today' : ''}${dayActivities.length > 0 ? ' has-event' : ''}`;
            cell.innerHTML = `<div class="calendar-day">${d}</div>`;

            dayActivities.slice(0, 3).forEach(act => {
                const event = document.createElement('div');
                event.className = `calendar-event event-${act.category}`;
                event.textContent = act.name;
                event.title = `${act.name} (${act.hours} jam)`;
                cell.appendChild(event);
            });

            if (dayActivities.length > 3) {
                const more = document.createElement('div');
                more.className = 'calendar-event';
                more.style.cssText = 'background:var(--bg-elevated);color:var(--fg-secondary)';
                more.textContent = `+${dayActivities.length - 3} lagi`;
                cell.appendChild(more);
            }

            container.appendChild(cell);
        }

        // Next month padding
        const totalCells = container.children.length - 7; // minus header
        const remaining = (7 - (totalCells % 7)) % 7;
        for (let i = 1; i <= remaining; i++) {
            const cell = document.createElement('div');
            cell.className = 'calendar-cell other-month';
            cell.innerHTML = `<div class="calendar-day">${i}</div>`;
            container.appendChild(cell);
        }
    }

    // ====== Utilities ======
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ====== Profile Management ======
    let profileData = {
        name: 'Mahasiswa Pengabdian',
        nim: '2108101001',
        group: 'Kelompok 01 • Posko Harapan',
        program: 'Teknik Informatika',
        target: 272,
        avatarDataUrl: null
    };

    async function loadProfile() {
        const client = getSupabase();
        if (client) {
            try {
                const { data, error } = await client
                    .from('plk_profiles')
                    .select('*')
                    .eq('id', 1)
                    .maybeSingle();
                if (!error && data) {
                    profileData = {
                        ...profileData,
                        name: data.name || profileData.name,
                        nim: data.nim || profileData.nim,
                        group: data.group_name || profileData.group,
                        program: data.program || profileData.program,
                        target: Number(data.target) || profileData.target,
                        avatarDataUrl: data.avatar_url || null
                    };
                    renderProfile();
                    return;
                }
            } catch (e) {
                console.warn('Profil Supabase tidak terjangkau, pakai localStorage:', e);
            }
        }
        try {
            const data = localStorage.getItem(PROFILE_STORAGE_KEY);
            if (data) {
                profileData = { ...profileData, ...JSON.parse(data) };
            }
        } catch (e) { /* use defaults */ }
        renderProfile(); // sama seperti loadActivities: render ulang bila fetch cloud gagal async
    }

    async function saveProfile() {
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profileData));
        const client = getSupabase();
        if (!client) return;
        try {
            const { error } = await client
                .from('plk_profiles')
                .upsert({
                    id: 1,
                    name: profileData.name,
                    nim: profileData.nim,
                    group_name: profileData.group,
                    program: profileData.program,
                    target: profileData.target,
                    avatar_url: profileData.avatarDataUrl,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });
            if (error) throw error;
        } catch (e) {
            console.warn('Gagal sinkron profil ke Supabase:', e);
            showToast('Profil tersimpan lokal, sinkron Supabase gagal', 'error');
        }
    }

    function renderProfile() {
        const nameEl = $('#profile-name-text');
        const subEl = $('#profile-sub-text');
        const groupEl = $('#profile-group-text');
        const programEl = $('#profile-program-text');
        const targetEl = $('#profile-target-text');
        const avatarEl = $('#profile-avatar-img');

        if (nameEl) nameEl.textContent = profileData.name;
        if (subEl) subEl.textContent = `NIM: ${profileData.nim} • ${profileData.program}`;
        if (groupEl) groupEl.textContent = profileData.group;
        if (programEl) programEl.textContent = `Program PLK 2026`;
        if (targetEl) targetEl.textContent = `Target: ${profileData.target} Jam`;
        if (avatarEl && profileData.avatarDataUrl) {
            avatarEl.src = profileData.avatarDataUrl;
        } else if (avatarEl) {
            avatarEl.src = 'logo.png';
        }
    }

    function bindProfileEvents() {
        const editBtn = $('#btn-edit-profile');
        const modalOverlay = $('#profile-modal-overlay');
        const closeBtn = $('#profile-modal-close');
        const cancelBtn = $('#btn-profile-cancel');
        const form = $('#profile-form');
        const photoInput = $('#edit-profile-photo-input');
        const resetAvatarBtn = $('#btn-reset-avatar');

        if (!editBtn || !modalOverlay) return;

        editBtn.addEventListener('click', openProfileModal);
        closeBtn.addEventListener('click', closeProfileModal);
        cancelBtn.addEventListener('click', closeProfileModal);
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeProfileModal();
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            saveProfileForm();
        });

        if (photoInput) {
            photoInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const previewImg = $('#profile-avatar-preview');
                    if (previewImg) previewImg.src = ev.target.result;
                    profileData.avatarDataUrl = ev.target.result;
                };
                reader.readAsDataURL(file);
            });
        }

        if (resetAvatarBtn) {
            resetAvatarBtn.addEventListener('click', () => {
                profileData.avatarDataUrl = null;
                const previewImg = $('#profile-avatar-preview');
                if (previewImg) previewImg.src = 'logo.png';
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modalOverlay.classList.contains('active')) {
                closeProfileModal();
            }
        });
    }

    function openProfileModal() {
        const overlay = $('#profile-modal-overlay');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Fill form
        const nameInput = $('#edit-profile-name');
        const nimInput = $('#edit-profile-nim');
        const groupInput = $('#edit-profile-group');
        const programInput = $('#edit-profile-program');
        const targetInput = $('#edit-profile-target');
        const previewImg = $('#profile-avatar-preview');

        if (nameInput) nameInput.value = profileData.name;
        if (nimInput) nimInput.value = profileData.nim;
        if (groupInput) groupInput.value = profileData.group;
        if (programInput) programInput.value = profileData.program;
        if (targetInput) targetInput.value = profileData.target;
        if (previewImg) previewImg.src = profileData.avatarDataUrl || 'logo.png';
    }

    function closeProfileModal() {
        const overlay = $('#profile-modal-overlay');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }

    function saveProfileForm() {
        const nameInput = $('#edit-profile-name');
        const nimInput = $('#edit-profile-nim');
        const groupInput = $('#edit-profile-group');
        const programInput = $('#edit-profile-program');
        const targetInput = $('#edit-profile-target');

        profileData.name = (nameInput.value || '').trim() || 'Mahasiswa Pengabdian';
        profileData.nim = (nimInput.value || '').trim() || '-';
        profileData.group = (groupInput.value || '').trim() || '-';
        profileData.program = (programInput.value || '').trim() || '-';
        profileData.target = parseInt(targetInput.value) || 272;

        saveProfile();
        renderProfile();
        closeProfileModal();
        showToast('Profil berhasil diperbarui!', 'success');
    }

    // ====== Start ======
    document.addEventListener('DOMContentLoaded', init);
})();
