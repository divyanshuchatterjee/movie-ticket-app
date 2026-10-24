import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getFirestore, collection, getDocs, setDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);
let watchlistCollection = null;

const WORKER_URL = 'https://tmdb-proxy.divyanshukdb.workers.dev';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';
const WATCHLIST_KEY = 'totuKutuWatchlist';

const PROVIDER_IDS = {
  Netflix: 8,
  Prime: 119,
  JioHotstar: 2336,
  TMDB: null
};

let currentMediaType = 'movie';
let currentPlatform = 'Netflix';
let selectedMedia = null;
let selectedSnacks = [];
let selectedPlace = '';
let debounceTimer = null;
let currentAppTab = 'cinema';
let watchlistStatus = 'all';
let editingWatchlistId = null;
let editingStatus = 'want';

let watchlist = [];

function loadLocalWatchlist() {
  try {
    const stored = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch (error) {
    console.error('Local watchlist migration error:', error);
    return [];
  }
}

async function loadWatchlistFromFirebase() {
  if (!watchlistCollection) return;

  const snapshot = await getDocs(watchlistCollection);
  watchlist = snapshot.docs.map(snapshotDoc => ({
    id: snapshotDoc.data().id ?? snapshotDoc.id,
    ...snapshotDoc.data()
  }));

  // Migrate the old localStorage watchlist once if Firebase has no data yet.
  if (watchlist.length === 0) {
    const localItems = loadLocalWatchlist();
    if (localItems.length > 0) {
      for (const item of localItems) {
        await saveWatchlistItemToFirebase(item);
      }
      watchlist = localItems;
      localStorage.removeItem(WATCHLIST_KEY);
      console.log(`Migrated ${watchlist.length} watchlist item(s) to Firestore`);
    }
  }

  updateWatchlistCounters();
}

async function saveWatchlistItemToFirebase(item) {
  if (!watchlistCollection) throw new Error('Firebase watchlist is not initialized');

  const itemId = `${item.mediaType}-${item.id}`;
  await setDoc(doc(watchlistCollection, itemId), item);
}

async function deleteWatchlistItemFromFirebase(id, mediaType) {
  if (!watchlistCollection) throw new Error('Firebase watchlist is not initialized');
  await deleteDoc(doc(watchlistCollection, `${mediaType}-${id}`));
}

function handleFirebaseError(error, action = 'save changes') {
  console.error(`Firebase watchlist ${action} error:`, error);
  alert(`Could not ${action} to Firebase. Please check your connection and try again.`);
}

function switchAppTab(tab) {
  currentAppTab = tab;
  const cinema = document.getElementById('cinema-tab');
  const list = document.getElementById('watchlist-tab');

  cinema.classList.toggle('hidden', tab !== 'cinema');
  list.classList.toggle('hidden', tab !== 'watchlist');

  document.getElementById('tab-cinema').classList.toggle('active', tab === 'cinema');
  document.getElementById('tab-watchlist').classList.toggle('active', tab === 'watchlist');

  if (tab === 'watchlist') renderWatchlist();
}

function setMediaType(type) {
  if (currentMediaType === type) return;

  currentMediaType = type;
  selectedMedia = null;

  document.getElementById('btn-media-movie').classList.toggle('active', type === 'movie');
  document.getElementById('btn-media-tv').classList.toggle('active', type === 'tv');

  const searchInput = document.getElementById('search-input');
  const mediaLabel = type === 'movie' ? 'movies' : 'TV shows';
  searchInput.placeholder = `Type to live search ${currentPlatform} ${mediaLabel}...`;

  fetchMediaByPlatform(currentPlatform, searchInput.value);
}

async function fetchMediaByPlatform(platformName = 'Netflix', searchQuery = '') {
  const grid = document.getElementById('movie-grid');
  const providerId = PROVIDER_IDS[platformName];
  const cleanQuery = searchQuery.trim();
  const mediaLabel = currentMediaType === 'movie' ? 'Movies' : 'TV Shows';
  const isTMDB = platformName === 'TMDB';

  grid.innerHTML = `<div class="loading-text"><i class="fa-solid fa-spinner fa-spin"></i> ${cleanQuery ? 'Searching' : 'Fetching'} ${isTMDB ? 'TMDB' : platformName} ${mediaLabel}...</div>`;

  try {
    let rawResults = [];

    if (cleanQuery) {
      // TMDB search is global: it includes titles that are unreleased and
      // titles that are not available on Netflix/Prime/JioHotstar.
      const searchUrl = `${WORKER_URL}/search/${currentMediaType}?language=en-US&query=${encodeURIComponent(cleanQuery)}&page=1&include_adult=false`;
      const response = await fetch(searchUrl);
      if (!response.ok) throw new Error(`Search failed: ${response.status}`);
      const data = await response.json();
      rawResults = data.results || [];

      // Keep the existing platform search behaviour, but do not apply a
      // provider filter when TMDB is selected.
      if (!isTMDB) {
        const detailPromises = rawResults.map(async (item) => {
          try {
            const providersUrl = `${WORKER_URL}/${currentMediaType}/${item.id}/watch/providers`;
            const pRes = await fetch(providersUrl);
            const pData = await pRes.json();
            const inProviders = pData.results?.IN?.flatrate || [];
            return inProviders.some(p => p.provider_id === providerId) ? item : null;
          } catch {
            return null;
          }
        });
        rawResults = (await Promise.all(detailPromises)).filter(Boolean);
      }

      rawResults.sort((a, b) => {
        const titleA = (a.title || a.name || a.original_title || a.original_name || '').toLowerCase();
        const titleB = (b.title || b.name || b.original_title || b.original_name || '').toLowerCase();
        const startsA = titleA.startsWith(cleanQuery.toLowerCase());
        const startsB = titleB.startsWith(cleanQuery.toLowerCase());
        if (startsA && !startsB) return -1;
        if (!startsA && startsB) return 1;
        return (b.popularity || 0) - (a.popularity || 0);
      });
    } else if (isTMDB) {
      // With no search text, TMDB acts as an "Upcoming" catalogue.
      // This intentionally includes movies/shows that have not released yet.
      const today = new Date().toISOString().split('T')[0];
      const dateField = currentMediaType === 'movie' ? 'primary_release_date' : 'first_air_date';
      const discoverUrl = `${WORKER_URL}/discover/${currentMediaType}?language=en-US&sort_by=popularity.desc&${dateField}.gte=${today}&include_adult=false&page=1`;
      const response = await fetch(discoverUrl);
      if (!response.ok) throw new Error(`TMDB discover failed: ${response.status}`);
      const data = await response.json();
      rawResults = data.results || [];
    } else {
      const discoverUrl = `${WORKER_URL}/discover/${currentMediaType}?language=en-US&sort_by=popularity.desc&watch_region=IN&with_watch_providers=${providerId}`;
      const response = await fetch(discoverUrl);
      if (!response.ok) throw new Error(`Discover failed: ${response.status}`);
      const data = await response.json();
      rawResults = data.results || [];
    }

    const items = rawResults.slice(0, 12).map(item => ({
      id: item.id,
      title: item.title || item.name || item.original_title || item.original_name,
      rating: item.vote_average ? `${item.vote_average.toFixed(1)}/10` : 'N/A',
      year: (item.release_date || item.first_air_date || 'TBA').split('-')[0],
      poster: item.poster_path ? `${TMDB_IMAGE_BASE_URL}${item.poster_path}` : 'https://via.placeholder.com/300x450?text=No+Poster',
      platform: platformName,
      mediaType: currentMediaType,
      releaseDate: item.release_date || item.first_air_date || null
    }));

    renderItems(items);
  } catch (err) {
    console.error('Worker/TMDB Fetch Error:', err);
    grid.innerHTML = `<div class="loading-text error-text">Failed to load ${mediaLabel.toLowerCase()}. Please check network/worker proxy.</div>`;
  }
}
function renderItems(items) {
  const grid = document.getElementById('movie-grid');
  grid.innerHTML = '';
  const mediaLabel = currentMediaType === 'movie' ? 'movies' : 'TV shows';

  if (items.length === 0) {
    grid.innerHTML = `<div class="loading-text">No ${mediaLabel} found on ${currentPlatform} matching your search.</div>`;
    return;
  }

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = `movie-card ${selectedMedia?.id === item.id ? 'selected' : ''}`;
    const badgeClass = item.platform === 'Netflix'
      ? 'badge-netflix'
      : item.platform === 'Prime'
        ? 'badge-prime'
        : item.platform === 'JioHotstar'
          ? 'badge-jiohotstar'
          : 'badge-tmdb';
    const tmdbPath = item.mediaType === 'tv' ? 'tv' : 'movie';
    const existing = getWatchlistItem(item.id, item.mediaType);

    card.innerHTML = `
      <div class="poster-container">
        <img src="${item.poster}" alt="${escapeHtml(item.title)}" crossorigin="anonymous" />
        <span class="platform-badge ${badgeClass}">${item.platform === 'TMDB' ? 'TMDB' : item.platform}</span>
        <span class="type-tag">${item.mediaType === 'tv' ? '📺 TV' : '🍿 Movie'}</span>
        ${existing ? `<span class="watchlist-badge"><i class="fa-solid ${existing.status === 'watched' ? 'fa-check' : 'fa-bookmark'}"></i></span>` : ''}
      </div>
      <div class="movie-info">
        <h3>${escapeHtml(item.title)}</h3>
        <div class="movie-meta">
          <span>⭐ ${item.rating} • ${item.year}</span>
          <a href="https://www.themoviedb.org/${tmdbPath}/${item.id}" target="_blank" rel="noopener noreferrer"
             class="external-link-icon" title="View on TMDB" onclick="event.stopPropagation();">
             <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </a>
        </div>
        <button type="button" class="watchlist-add-btn ${existing ? 'in-list' : ''}" data-watchlist-id="${item.id}" data-watchlist-type="${item.mediaType}">
          <i class="fa-solid ${existing ? 'fa-check' : 'fa-bookmark'}"></i>
          ${existing ? (existing.status === 'watched' ? 'Watched' : 'In Watchlist') : 'Add to Watchlist'}
        </button>
      </div>
    `;

    card.dataset.id = `${item.mediaType}-${item.id}`;
    card._mediaItem = item;

    // Keep watchlist actions completely separate from the card/ticket selection flow.
    // Preventing the default action and stopping propagation avoids the booking modal
    // being triggered by clicks originating from the watchlist button.
    const watchlistButton = card.querySelector('.watchlist-add-btn');
    watchlistButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await toggleWatchlistItem(item.id, item.mediaType);
    });

    card.onclick = () => {
      document.querySelectorAll('.movie-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedMedia = item;
    };

    grid.appendChild(card);
  });
}

function filterPlatform(platform) {
  currentPlatform = platform;

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-platform') === platform);
  });

  const searchInput = document.getElementById('search-input');
  const clearBtn = document.getElementById('clear-search-btn');
  searchInput.value = '';
  const mediaLabel = currentMediaType === 'movie' ? 'movies' : 'TV shows';
  searchInput.placeholder = `Type to live search ${platform} ${mediaLabel}...`;
  clearBtn.style.display = 'none';

  fetchMediaByPlatform(platform);
}

function handleLiveSearch(event) {
  const query = event.target.value;
  document.getElementById('clear-search-btn').style.display = query.length > 0 ? 'block' : 'none';

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    fetchMediaByPlatform(currentPlatform, query);
  }, 250);
}

function clearSearch() {
  const searchInput = document.getElementById('search-input');
  document.getElementById('clear-search-btn').style.display = 'none';
  searchInput.value = '';
  fetchMediaByPlatform(currentPlatform, '');
}

function toggleSnack(card, snackName) {
  if (card.classList.contains('selected')) {
    card.classList.remove('selected');
    selectedSnacks = selectedSnacks.filter(s => s !== snackName);
  } else {
    card.classList.add('selected');
    selectedSnacks.push(snackName);
  }
}

function getWatchlistItem(id, mediaType) {
  return watchlist.find(item => String(item.id) === String(id) && item.mediaType === mediaType);
}

async function toggleWatchlistItem(id, mediaType) {
  const item = getWatchlistItem(id, mediaType);

  if (item) {
    if (confirm(`Remove "${item.title}" from your watchlist?`)) {
      watchlist = watchlist.filter(entry => !(String(entry.id) === String(id) && entry.mediaType === mediaType));
      try { await deleteWatchlistItemFromFirebase(id, mediaType); } catch (error) {
        watchlist.push(item);
        handleFirebaseError(error, 'remove the item');
        return;
      }
      updateWatchlistCounters();
      renderItemsFromCurrentState();
      if (currentAppTab === 'watchlist') renderWatchlist();
    }
    return;
  }

  const source = selectedMedia?.id === id && selectedMedia?.mediaType === mediaType
    ? selectedMedia
    : findCurrentItem(id, mediaType);

  if (!source) return;

  watchlist.unshift({
    id: source.id,
    title: source.title,
    rating: source.rating,
    tmdbRating: parseFloat(source.rating) || 0,
    year: source.year,
    poster: source.poster,
    platform: source.platform,
    mediaType: source.mediaType,
    status: 'want',
    watchedDate: null,
    userRating: null,
    notes: '',
    addedAt: new Date().toISOString()
  });

  try { await saveWatchlistItemToFirebase(watchlist[0]); } catch (error) {
    watchlist.shift();
    updateWatchlistCounters();
    handleFirebaseError(error);
    return;
  }
  updateWatchlistCounters();
  renderItemsFromCurrentState();
}

function findCurrentItem(id, mediaType) {
  const cards = [...document.querySelectorAll('.movie-card')];
  for (const card of cards) {
    if (card.dataset.id === `${mediaType}-${id}`) return card._mediaItem;
  }
  return null;
}

function renderItemsFromCurrentState() {
  // Re-fetching the current view keeps the existing TMDB/provider flow intact.
  const query = document.getElementById('search-input').value;
  fetchMediaByPlatform(currentPlatform, query);
}

function openWatchlistModal(id, mediaType) {
  const item = getWatchlistItem(id, mediaType);
  if (!item) return;

  editingWatchlistId = `${mediaType}-${id}`;
  editingStatus = item.status;

  document.getElementById('watchlist-modal-title').textContent = item.title;
  document.getElementById('watched-date').value = item.watchedDate || '';
  document.getElementById('user-rating').value = item.userRating || '';
  document.getElementById('watchlist-notes').value = item.notes || '';
  selectEditStatus(item.status, false);

  document.getElementById('watchlist-modal').classList.add('active');
}

function selectEditStatus(status, rerender = true) {
  editingStatus = status;
  document.getElementById('status-want-btn').classList.toggle('active', status === 'want');
  document.getElementById('status-watched-btn').classList.toggle('active', status === 'watched');

  const dateInput = document.getElementById('watched-date');
  if (status === 'watched' && !dateInput.value) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }
  if (rerender) return;
}

async function saveWatchlistEdit() {
  if (!editingWatchlistId) return;

  const item = watchlist.find(entry => `${entry.mediaType}-${entry.id}` === editingWatchlistId);
  if (!item) return;

  item.status = editingStatus;
  item.watchedDate = editingStatus === 'watched'
    ? (document.getElementById('watched-date').value || new Date().toISOString().split('T')[0])
    : null;
  item.userRating = document.getElementById('user-rating').value || null;
  item.notes = document.getElementById('watchlist-notes').value.trim();

  try { await saveWatchlistItemToFirebase(item); } catch (error) { handleFirebaseError(error); return; }
  updateWatchlistCounters();
  closeWatchlistModal();
  renderWatchlist();
}

function closeWatchlistModal() {
  document.getElementById('watchlist-modal').classList.remove('active');
  editingWatchlistId = null;
}

async function removeWatchlistItem(id, mediaType) {
  const item = getWatchlistItem(id, mediaType);
  if (!item) return;

  if (!confirm(`Remove "${item.title}" from your watchlist?`)) return;

  watchlist = watchlist.filter(entry => !(String(entry.id) === String(id) && entry.mediaType === mediaType));
  try { await deleteWatchlistItemFromFirebase(id, mediaType); } catch (error) {
    // Restore the item in memory if Firebase deletion failed.
    watchlist.push(item);
    handleFirebaseError(error, 'remove the item');
    return;
  }
  updateWatchlistCounters();
  renderWatchlist();
}

function setWatchlistStatus(status) {
  watchlistStatus = status;
  document.querySelectorAll('.watch-status-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === status);
  });
  renderWatchlist();
}

function renderWatchlist() {
  const grid = document.getElementById('watchlist-grid');
  if (!grid) return;

  const search = document.getElementById('watchlist-search-input').value.trim().toLowerCase();
  const type = document.getElementById('watchlist-type-filter').value;
  const platform = document.getElementById('watchlist-platform-filter').value;
  const sort = document.getElementById('watchlist-sort').value;

  let items = watchlist.filter(item => {
    const statusMatch = watchlistStatus === 'all' || item.status === watchlistStatus;
    const typeMatch = type === 'all' || item.mediaType === type;
    const platformMatch = platform === 'all' || item.platform === platform;
    const searchMatch = !search || item.title.toLowerCase().includes(search);
    return statusMatch && typeMatch && platformMatch && searchMatch;
  });

  items.sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'rating') return (b.tmdbRating || 0) - (a.tmdbRating || 0);
    if (sort === 'watchedDate') return (b.watchedDate || '').localeCompare(a.watchedDate || '');
    return new Date(b.addedAt) - new Date(a.addedAt);
  });

  updateWatchlistCounters();

  if (!items.length) {
    grid.innerHTML = `
      <div class="empty-watchlist">
        <div class="empty-icon"><i class="fa-solid fa-clapperboard"></i></div>
        <h3>${watchlist.length ? 'Nothing here yet' : 'Your watchlist is empty'}</h3>
        <p>${watchlist.length ? 'Try changing the filters above.' : 'Go to Cinema and tap “Add to Watchlist” on something you want to watch.'}</p>
        ${!watchlist.length ? `<button class="btn-small" onclick="switchAppTab('cinema')"><i class="fa-solid fa-film"></i> Browse Titles</button>` : ''}
      </div>`;
    return;
  }

  grid.innerHTML = items.map(item => {
    const badgeClass = item.platform === 'Netflix'
      ? 'badge-netflix'
      : item.platform === 'Prime'
        ? 'badge-prime'
        : item.platform === 'JioHotstar'
          ? 'badge-jiohotstar'
          : 'badge-tmdb';

    const userStars = item.userRating
      ? '★'.repeat(Number(item.userRating)) + '☆'.repeat(5 - Number(item.userRating))
      : '';

    return `
      <article class="watchlist-card">
        <div class="watchlist-poster">
          <img src="${item.poster}" alt="${escapeHtml(item.title)}" crossorigin="anonymous">
          <span class="platform-badge ${badgeClass}">${item.platform === 'TMDB' ? 'TMDB' : item.platform}</span>
          <span class="watch-status-pill ${item.status}">${item.status === 'watched' ? '✓ Watched' : '🔖 Want to Watch'}</span>
        </div>
        <div class="watchlist-card-body">
          <div class="watchlist-title-row">
            <div>
              <h3>${escapeHtml(item.title)}</h3>
              <span class="watchlist-subtitle">${item.mediaType === 'tv' ? '📺 TV Show' : '🍿 Movie'} • ${item.year}</span>
            </div>
            <a href="https://www.themoviedb.org/${item.mediaType === 'tv' ? 'tv' : 'movie'}/${item.id}"
               target="_blank" rel="noopener noreferrer" title="View on TMDB">
              <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
          </div>

          <div class="watchlist-rating">⭐ ${item.rating}${userStars ? ` <span class="your-rating">${userStars}</span>` : ''}</div>

          ${item.watchedDate ? `<div class="watched-date"><i class="fa-regular fa-calendar-check"></i> Watched ${formatDate(item.watchedDate)}</div>` : ''}
          ${item.notes ? `<p class="watchlist-note">“${escapeHtml(item.notes)}”</p>` : ''}

          <div class="watchlist-actions">
            <button class="action-btn primary" onclick="openWatchlistModal(${item.id}, '${item.mediaType}')">
              <i class="fa-solid fa-pen"></i> Edit
            </button>
            <button class="action-btn" onclick="toggleWatchedStatus(${item.id}, '${item.mediaType}')">
              <i class="fa-solid ${item.status === 'watched' ? 'fa-bookmark' : 'fa-check'}"></i>
              ${item.status === 'watched' ? 'Move to Want' : 'Mark Watched'}
            </button>
            <button class="action-btn danger" onclick="removeWatchlistItem(${item.id}, '${item.mediaType}')">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
      </article>`;
  }).join('');
}

async function toggleWatchedStatus(id, mediaType) {
  const item = getWatchlistItem(id, mediaType);
  if (!item) return;

  item.status = item.status === 'watched' ? 'want' : 'watched';
  item.watchedDate = item.status === 'watched'
    ? (item.watchedDate || new Date().toISOString().split('T')[0])
    : null;

  try { await saveWatchlistItemToFirebase(item); } catch (error) { handleFirebaseError(error); return; }
  updateWatchlistCounters();
  renderWatchlist();
}

function updateWatchlistCounters() {
  const want = watchlist.filter(item => item.status === 'want').length;
  const watched = watchlist.filter(item => item.status === 'watched').length;

  document.getElementById('want-count').textContent = want;
  document.getElementById('watched-count').textContent = watched;
  document.getElementById('watchlist-count').textContent = watchlist.length;
}

function formatDate(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[char]));
}

function openBookingModal() {
  if (!selectedMedia) {
    alert('Please select a movie or TV show first!');
    return;
  }
  document.getElementById('booking-modal').classList.add('active');
}

function closeBookingModal() {
  document.getElementById('booking-modal').classList.remove('active');
}

function selectPlace(place) {
  selectedPlace = place;
  document.getElementById('place-bed').classList.toggle('selected', place === 'BED');
  document.getElementById('place-desk').classList.toggle('selected', place === 'OFFICE TABLE');
}

function confirmAndDownload() {
  const dateVal = document.getElementById('watch-date').value;

  if (!dateVal) {
    alert('Please select a valid date!');
    return;
  }

  if (!selectedPlace) {
    alert('Please select a viewing spot (BED or OFFICE TABLE)!');
    return;
  }

  closeBookingModal();
  downloadTicketImage(dateVal, selectedPlace);
}

function downloadTicketImage(dateStr, placeStr) {
  const formattedDate = new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  document.getElementById('pdf-type-label').textContent =
    selectedMedia.mediaType === 'tv' ? 'Selected TV Show' : 'Selected Movie';
  document.getElementById('pdf-movie-title').textContent = selectedMedia.title;
  document.getElementById('pdf-platform').textContent = selectedMedia.platform;
  document.getElementById('pdf-poster').src = selectedMedia.poster;
  document.getElementById('pdf-ticket-id').textContent = Math.floor(1000 + Math.random() * 9000);
  document.getElementById('pdf-date').textContent = formattedDate;
  document.getElementById('pdf-place').textContent = placeStr === 'BED' ? 'BED 🛏️' : 'OFFICE TABLE 🖥️';
  document.getElementById('pdf-snacks').textContent =
    selectedSnacks.length > 0 ? selectedSnacks.join(', ') : 'No Snacks Selected';

  const wrapper = document.getElementById('ticket-wrapper');
  const element = document.getElementById('ticket-content');

  wrapper.style.visibility = 'visible';

  setTimeout(() => {
    html2canvas(element, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff'
    }).then(canvas => {
      const imgData = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = imgData;
      link.download = `${selectedMedia.title.replace(/[^a-zA-Z0-9]/g, '_')}_Ticket.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      wrapper.style.visibility = 'hidden';
    }).catch(err => {
      console.error('Image capture error:', err);
      wrapper.style.visibility = 'hidden';
    });
  }, 150);
}

// Initialisation
async function initializeFirebaseWatchlist() {
  try {
    await signInAnonymously(auth);
    const uid = auth.currentUser.uid;
    watchlistCollection = collection(db, 'watchlists', uid, 'items');
    await loadWatchlistFromFirebase();
    console.log('Firebase watchlist ready for anonymous user:', uid);
  } catch (error) {
    console.error('Firebase initialization failed:', error);
    alert('Firebase could not be initialized. Your watchlist cannot be saved until Firebase is available.');
  }

  document.getElementById('watch-date').valueAsDate = new Date();
  updateWatchlistCounters();
  fetchMediaByPlatform('Netflix');
}

initializeFirebaseWatchlist();

// The UI uses inline onclick handlers, so expose module functions globally.
Object.assign(window, {
  switchAppTab, setMediaType, filterPlatform, clearSearch, toggleSnack, openBookingModal,
  setWatchlistStatus, closeWatchlistModal, selectEditStatus, saveWatchlistEdit, closeBookingModal,
  selectPlace, confirmAndDownload, removeWatchlistItem, toggleWatchedStatus, toggleWatchlistItem,
  openWatchlistModal, handleLiveSearch
});
