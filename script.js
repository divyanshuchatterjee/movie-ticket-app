// Live Cloudflare Worker URL
const WORKER_URL = 'https://tmdb-proxy.divyanshukdb.workers.dev';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';

const PROVIDER_IDS = {
  Netflix: 8,
  Prime: 119,
  JioHotstar: 2336
};

let currentMediaType = 'movie'; // 'movie' or 'tv'
let currentPlatform = 'Netflix';
let selectedMedia = null;
let selectedSnacks = [];
let selectedPlace = '';
let debounceTimer = null;

// Set default date picker value to today
document.getElementById('watch-date').valueAsDate = new Date();

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
  const cleanQuery = searchQuery.trim().toLowerCase();
  const mediaLabel = currentMediaType === 'movie' ? 'Movies' : 'TV Shows';
  
  grid.innerHTML = `<div class="loading-text"><i class="fa-solid fa-spinner fa-spin"></i> ${searchQuery ? 'Searching' : 'Fetching'} ${platformName} ${mediaLabel}...</div>`;

  try {
    let rawResults = [];

    if (cleanQuery) {
      const searchUrl = `${WORKER_URL}/search/${currentMediaType}?language=en-US&query=${encodeURIComponent(searchQuery)}&page=1`;
      const response = await fetch(searchUrl);
      const data = await response.json();

      if (data.results && data.results.length > 0) {
        const detailPromises = data.results.map(async (item) => {
          const providersUrl = `${WORKER_URL}/${currentMediaType}/${item.id}/watch/providers`;
          const pRes = await fetch(providersUrl);
          const pData = await pRes.json();
          
          const inProviders = pData.results?.IN?.flatrate || [];
          const isAvailable = inProviders.some(p => p.provider_id === providerId);
          
          return isAvailable ? item : null;
        });

        const filtered = await Promise.all(detailPromises);
        rawResults = filtered.filter(m => m !== null);

        rawResults.sort((a, b) => {
          const titleA = (a.title || a.name || a.original_title || a.original_name || '').toLowerCase();
          const titleB = (b.title || b.name || b.original_title || b.original_name || '').toLowerCase();

          const startsA = titleA.startsWith(cleanQuery);
          const startsB = titleB.startsWith(cleanQuery);

          if (startsA && !startsB) return -1;
          if (!startsA && startsB) return 1;
          return b.popularity - a.popularity;
        });
      }
    } else {
      const discoverUrl = `${WORKER_URL}/discover/${currentMediaType}?language=en-US&sort_by=popularity.desc&watch_region=IN&with_watch_providers=${providerId}`;
      const response = await fetch(discoverUrl);
      const data = await response.json();
      rawResults = data.results || [];
    }

    const items = rawResults.slice(0, 12).map(item => ({
      id: item.id,
      title: item.title || item.name || item.original_title || item.original_name,
      rating: item.vote_average ? `${item.vote_average.toFixed(1)}/10` : '8.0/10',
      year: (item.release_date || item.first_air_date || '2026').split('-')[0],
      poster: item.poster_path ? `${TMDB_IMAGE_BASE_URL}${item.poster_path}` : 'https://via.placeholder.com/300x450?text=No+Poster',
      platform: platformName,
      mediaType: currentMediaType
    }));

    renderItems(items);
  } catch (err) {
    console.error("Worker/TMDB Fetch Error:", err);
    grid.innerHTML = `<div class="loading-text" style="color: #e50914;">Failed to load ${mediaLabel.toLowerCase()}. Please check network/worker proxy.</div>`;
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
    const badgeClass = item.platform === 'Netflix' ? 'badge-netflix' : item.platform === 'Prime' ? 'badge-prime' : 'badge-jiohotstar';
    const tmdbPath = item.mediaType === 'tv' ? 'tv' : 'movie';

    card.innerHTML = `
      <div class="poster-container">
        <img src="${item.poster}" alt="${item.title}" crossorigin="anonymous" />
        <span class="platform-badge ${badgeClass}">${item.platform}</span>
        <span class="type-tag">${item.mediaType === 'tv' ? '📺 TV' : '🍿 Movie'}</span>
      </div>
      <div class="movie-info">
        <h3>${item.title}</h3>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.4rem;">
          <span style="font-size: 0.8rem; color: #a0a5b5;">⭐ ${item.rating} • ${item.year}</span>
          <a href="https://www.themoviedb.org/${tmdbPath}/${item.id}" target="_blank" rel="noopener noreferrer" class="external-link-icon" title="View on TMDB" onclick="event.stopPropagation();">
             <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </a>
        </div>
      </div>
    `;

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
  const clearBtn = document.getElementById('clear-search-btn');
  
  clearBtn.style.display = query.length > 0 ? 'block' : 'none';

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

  document.getElementById('pdf-type-label').textContent = selectedMedia.mediaType === 'tv' ? 'Selected TV Show' : 'Selected Movie';
  document.getElementById('pdf-movie-title').textContent = selectedMedia.title;
  document.getElementById('pdf-platform').textContent = selectedMedia.platform;
  document.getElementById('pdf-poster').src = selectedMedia.poster;
  document.getElementById('pdf-ticket-id').textContent = Math.floor(1000 + Math.random() * 9000);
  document.getElementById('pdf-date').textContent = formattedDate;
  document.getElementById('pdf-place').textContent = placeStr === 'BED' ? 'BED 🛏️' : 'OFFICE TABLE 🖥️';
  document.getElementById('pdf-snacks').textContent = selectedSnacks.length > 0 ? selectedSnacks.join(', ') : 'No Snacks Selected';

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

// Initial Load - Defaults to Netflix Movies
fetchMediaByPlatform('Netflix');