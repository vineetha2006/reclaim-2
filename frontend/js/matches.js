/**
 * ReClaim - Member 2: Matches Controller
 * Handles Match cards rendering, 6-criteria scoring visualization,
 * search & filters, modal breakdown, and verification bridges.
 */

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireLogin()) return;

  const container = document.getElementById('matchesContainer');
  const searchInput = document.getElementById('matchSearchInput');
  const categoryFilter = document.getElementById('matchCategoryFilter');
  const scoreFilter = document.getElementById('matchScoreFilter');
  const statusFilter = document.getElementById('matchStatusFilter');
  const runAutoBtn = document.getElementById('runAutoMatchBtn');
  const messageBox = document.getElementById('matchesMessage');

  // Modal elements
  const modal = document.getElementById('matchDetailModal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const closeModalBtn2 = document.getElementById('closeModalBtn2');
  const startVerificationBtn = document.getElementById('startVerificationBtn');
  const modalTitle = document.getElementById('modalTitle');
  const modalScoreSummary = document.getElementById('modalScoreSummary');
  const breakdownTableBody = document.getElementById('breakdownTableBody');
  let allMatches = [];
  let selectedMatch = null;

  // Check URL parameters for direct match selection from notification
  const urlParams = new URLSearchParams(window.location.search);
  const targetMatchId = urlParams.get('matchId');
   // Member 3: Ownership verification form elements
const ownershipVerificationSection = document.getElementById('ownershipVerificationSection');
const ownershipVerificationForm = document.getElementById('ownershipVerificationForm');
const verificationFormMessage = document.getElementById('verificationFormMessage');
const submitVerificationAnswersBtn = document.getElementById('submitVerificationAnswersBtn');
  async function loadMatches() {
    container.innerHTML = '<p class="muted">Loading discovered matches…</p>';
    try {
      const res = await API.request('/api/matches');
      allMatches = res.matches || [];
      render();

      // If directed from notification with matchId, open modal immediately
      if (targetMatchId) {
        const found = allMatches.find(m => m._id === targetMatchId);
        if (found) {
          openModal(found);
        }
      }
    } catch (err) {
      container.innerHTML = `<p class="muted" style="color:var(--red)">Failed to load matches: ${escapeHTML(err.message)}</p>`;
    }
  }

  function getScoreClass(score) {
    if (score >= 85) return 'score-high';
    if (score >= 65) return 'score-mid';
    return 'score-fair';
  }

  function getStatusClass(status) {
    switch (status) {
      case 'PENDING': return 'status-pending';
      case 'CLAIM_IN_PROGRESS': return 'status-claim-in-progress';
      case 'VERIFIED': return 'status-verified';
      case 'RECLAIMED': return 'status-reclaimed';
      default: return 'status-pending';
    }
  }

  function formatStatusLabel(status) {
    switch (status) {
      case 'PENDING': return 'Pending Review';
      case 'CLAIM_IN_PROGRESS': return 'Claim in Progress';
      case 'VERIFIED': return 'Ownership Verified';
      case 'RECLAIMED': return 'Item Reclaimed';
      default: return status;
    }
  }

  function render() {
    const term = searchInput.value.trim().toLowerCase();
    const cat = categoryFilter.value.trim().toLowerCase();
    const minScore = parseInt(scoreFilter.value, 10) || 0;
    const stat = statusFilter.value.trim().toUpperCase();

    const filtered = allMatches.filter(m => {
      // Score filter
      if (m.score < minScore) return false;
      // Status filter
      if (stat && m.status !== stat) return false;

      // Category filter
      if (cat) {
        const lostCat = m.lostItem?.category?.toLowerCase() || '';
        const foundCat = m.foundItem?.category?.toLowerCase() || '';
        if (lostCat !== cat && foundCat !== cat) return false;
      }

      // Search keyword filter
      if (term) {
        const hay = [
          m.lostItem?.itemName,
          m.lostItem?.location,
          m.lostItem?.color,
          m.lostItem?.description,
          m.foundItem?.itemName,
          m.foundItem?.location,
          m.foundItem?.color,
          m.foundItem?.description,
        ].filter(Boolean).join(' ').toLowerCase();

        if (!hay.includes(term)) return false;
      }

      return true;
    });

    if (!filtered.length) {
      container.innerHTML = `
        <div class="panel" style="text-align:center;padding:48px 24px;">
          <div style="font-size:2.8rem;margin-bottom:12px;">🔍</div>
          <h3>No matching belongings found</h3>
          <p class="muted" style="max-width:520px;margin:8px auto 20px;">
            No potential matches currently meet the selected criteria. When someone reports an item with corresponding characteristics, ReClaim will notify you automatically.
          </p>
          <button class="btn btn-small" id="emptyRunAutoBtn">⚡ Trigger Auto-Matching Engine</button>
        </div>
      `;
      document.getElementById('emptyRunAutoBtn')?.addEventListener('click', triggerRecalculate);
      return;
    }

    container.innerHTML = filtered.map(m => {
      const lost = m.lostItem || {};
      const found = m.foundItem || {};
      const scoreClass = getScoreClass(m.score);
      const statusClass = getStatusClass(m.status);

      const lostImg = lost.imageUrl ? `<img src="${escapeHTML(lost.imageUrl)}" alt="${escapeHTML(lost.itemName)}" class="compare-box-img">` : '<div class="compare-box-img" style="display:flex;align-items:center;justify-content:center;font-size:1.6rem">🎒</div>';
      const foundImg = found.imageUrl ? `<img src="${escapeHTML(found.imageUrl)}" alt="${escapeHTML(found.itemName)}" class="compare-box-img">` : '<div class="compare-box-img" style="display:flex;align-items:center;justify-content:center;font-size:1.6rem">🔎</div>';

      const bd = m.breakdown || {};

      return `
        <article class="match-card" data-id="${escapeHTML(m._id)}">
          <div class="match-card-top">
            <div class="score-badge-wrap">
              <span class="score-pill ${scoreClass}">
                ⚡ ${escapeHTML(m.score)}% Match
              </span>
              <span class="match-status-tag ${statusClass}">
                ${escapeHTML(formatStatusLabel(m.status))}
              </span>
            </div>
            <div style="font-size:0.82rem;color:var(--muted)">
              Detected: ${escapeHTML(formatDate(m.createdAt))}
            </div>
          </div>

          <!-- Side-by-Side Comparison -->
          <div class="compare-container">
            <!-- Lost Item -->
            <div class="compare-box ${m.isOwner ? 'is-user' : ''}">
              ${lostImg}
              <div class="compare-box-details">
                <span class="compare-box-role role-lost">Lost Report ${m.isOwner ? '(Your Item)' : ''}</span>
                <h4>${escapeHTML(lost.itemName || 'Unnamed item')}</h4>
                <div class="compare-meta-list">
                  <div><strong>Category:</strong> ${escapeHTML(lost.category || 'N/A')}</div>
                  <div><strong>Colour:</strong> ${escapeHTML(lost.color || 'N/A')}</div>
                  <div><strong>Location:</strong> ${escapeHTML(lost.location || 'N/A')}</div>
                  <div><strong>Date Lost:</strong> ${escapeHTML(formatDate(lost.date))}</div>
                </div>
              </div>
            </div>

            <!-- VS Badge -->
            <div class="compare-divider">
              <span>VS</span>
            </div>

            <!-- Found Item -->
            <div class="compare-box ${m.isFinder ? 'is-user' : ''}">
              ${foundImg}
              <div class="compare-box-details">
                <span class="compare-box-role role-found">Found Report ${m.isFinder ? '(Reported by You)' : ''}</span>
                <h4>${escapeHTML(found.itemName || 'Unnamed item')}</h4>
                <div class="compare-meta-list">
                  <div><strong>Category:</strong> ${escapeHTML(found.category || 'N/A')}</div>
                  <div><strong>Colour:</strong> ${escapeHTML(found.color || 'N/A')}</div>
                  <div><strong>Location:</strong> ${escapeHTML(found.location || 'N/A')}</div>
                  <div><strong>Date Found:</strong> ${escapeHTML(formatDate(found.date))}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- 6 Criteria Quick Preview -->
          <div class="criteria-preview-grid">
            <div class="criteria-cell">
              <small>Name (20%)</small>
              <strong>${bd.name?.score ?? '-'}/20</strong>
            </div>
            <div class="criteria-cell">
              <small>Category (15%)</small>
              <strong>${bd.category?.score ?? '-'}/15</strong>
            </div>
            <div class="criteria-cell">
              <small>Colour (15%)</small>
              <strong>${bd.color?.score ?? '-'}/15</strong>
            </div>
            <div class="criteria-cell">
              <small>Description (20%)</small>
              <strong>${bd.description?.score ?? '-'}/20</strong>
            </div>
            <div class="criteria-cell">
              <small>Location (20%)</small>
              <strong>${bd.location?.score ?? '-'}/20</strong>
            </div>
            <div class="criteria-cell">
              <small>Date (10%)</small>
              <strong>${bd.date?.score ?? '-'}/10</strong>
            </div>
          </div>

          <!-- Card Actions -->
          <div class="match-actions-row">
            <button class="btn btn-outline btn-small view-breakdown-btn" data-id="${escapeHTML(m._id)}">
              🔍 View Scoring Breakdown →
            </button>
            <button class="btn btn-small verify-btn" data-id="${escapeHTML(m._id)}" style="${m.status === 'RECLAIMED' ? 'opacity:0.75;' : ''}">
              ${m.status === 'RECLAIMED' ? '✓ Reclaimed' : (m.status === 'VERIFIED' ? '✓ Ownership Verified' : (m.status === 'CLAIM_IN_PROGRESS' ? '⏳ Claim in Progress' : 'Initiate Claim (Module 3) →'))}
            </button>
          </div>
        </article>
      `;
    }).join('');

    // Attach click events to modal openers
    container.querySelectorAll('.view-breakdown-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const matchId = btn.getAttribute('data-id');
        const match = allMatches.find(m => m._id === matchId);
        if (match) openModal(match);
      });
    });

    container.querySelectorAll('.verify-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const matchId = btn.getAttribute('data-id');
        const match = allMatches.find(m => m._id === matchId);
        if (match) {
          // Member 3 recovery integration bridge
          openModal(match);
        }
      });
    });
  }

  function openModal(match) {
    selectedMatch = match;
    const lost = match.lostItem || {};
    const found = match.foundItem || {};
    const bd = match.breakdown || {};

    modalTitle.textContent = `${lost.itemName || 'Lost Item'} ⟷ ${found.itemName || 'Found Item'}`;

    const scoreClass = getScoreClass(match.score);
    modalScoreSummary.innerHTML = `
      <div class="score-pill ${scoreClass}" style="font-size:1.3rem;padding:8px 18px;">
        ${escapeHTML(match.score)}% Similarity Score
      </div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between;font-size:0.82rem;font-weight:700;color:var(--muted);margin-bottom:4px;">
          <span>Algorithm Confidence</span>
          <span>${match.score}/100</span>
        </div>
        <div class="score-bar-track">
          <div class="score-bar-fill" style="width:${Math.min(100, match.score)}%"></div>
        </div>
      </div>
    `;

    // Render contradiction warnings if any
    const existingWarn = document.getElementById('modalContradictionsNotice');
    if (existingWarn) existingWarn.remove();
    if (match.contradictions && match.contradictions.length > 0) {
      const warnBox = document.createElement('div');
      warnBox.id = 'modalContradictionsNotice';
      warnBox.style.cssText = 'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;margin-bottom:14px;';
      warnBox.innerHTML = `
        <div style="font-weight:700;color:#991b1b;font-size:0.82rem;margin-bottom:3px;">Contradiction / Conflict Shield Active:</div>
        ${match.contradictions.map(c => `<div style="color:#b91c1c;font-size:0.78rem;">⚠️ ${escapeHTML(c)}</div>`).join('')}
      `;
      modalScoreSummary.parentNode.insertBefore(warnBox, modalScoreSummary.nextSibling);
    }

    const criteriaRows = [
      { key: 'name', label: 'Item Name', weight: '20%', max: 20 },
      { key: 'category', label: 'Category', weight: '15%', max: 15 },
      { key: 'color', label: 'Colour Palette', weight: '15%', max: 15 },
      { key: 'description', label: 'Description Overlap', weight: '20%', max: 20 },
      { key: 'location', label: 'Location Proximity', weight: '20%', max: 20 },
      { key: 'date', label: 'Incident Date', weight: '10%', max: 10 },
    ];

    breakdownTableBody.innerHTML = criteriaRows.map(c => {
      const entry = bd[c.key] || { score: 0, max: c.max, note: 'Not evaluated' };
      const percentage = Math.round((entry.score / c.max) * 100);
      return `
        <tr>
          <td>
            <strong>${escapeHTML(c.label)}</strong>
            <div style="font-size:0.75rem;color:var(--muted)">Weight: ${c.weight}</div>
          </td>
          <td style="text-align:right">
            <strong style="color:var(--ink);font-size:1rem;">${entry.score}</strong>
            <span style="color:var(--muted);font-size:0.8rem">/${c.max}</span>
            <div class="score-bar-track" style="height:5px;">
              <div class="score-bar-fill" style="width:${percentage}%"></div>
            </div>
          </td>
          <td>
            <span style="font-size:0.88rem;color:#334155;">${escapeHTML(entry.note || 'Evaluated')}</span>
          </td>
        </tr>
      `;
    }).join('');

    // Render Verification & Recovery Audit Trail
    const auditTimeline = document.getElementById('auditTimeline');
    const auditLog = match.auditLog || [];
    if (auditTimeline) {
      if (!auditLog.length) {
        auditTimeline.innerHTML = '<span class="muted" style="font-size:0.8rem">No verification audit actions recorded yet.</span>';
      } else {
        auditTimeline.innerHTML = auditLog.map(entry => `
          <div style="background:#f8fafc;padding:9px 13px;border-radius:8px;border-left:3px solid var(--green);margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;font-weight:700;font-size:0.82rem;">
              <span>${escapeHTML(entry.action)} · ${escapeHTML(entry.actorName)} (${escapeHTML(entry.actorRole)})</span>
              <span style="color:#94a3b8;font-size:0.75rem;">${escapeHTML(formatDate(entry.timestamp))}</span>
            </div>
            ${entry.note ? `<div style="color:#475569;margin-top:3px;font-size:0.8rem;">${escapeHTML(entry.note)}</div>` : ''}
          </div>
        `).join('');
      }
    }

    // Role-based action controls (Owner / Finder vs Authorized Campus Verifier)
    const currentUser = JSON.parse(localStorage.getItem('reclaimUser') || '{}');
    const isVerifier = currentUser.role === 'VERIFIER' || currentUser.role === 'ADMIN' || match.isVerifier;
    // Member 3: Show ownership answers to the owner and authorized verifier
if (ownershipVerificationSection && ownershipVerificationForm) {
  const isOwner = Boolean(match.isOwner);
  const canViewVerification = isOwner || isVerifier;
  const answers = match.verificationAnswers || [];
  const hasSubmittedAnswers = answers.length > 0;
  const isClaimInProgress = match.status === 'CLAIM_IN_PROGRESS';

  ownershipVerificationSection.style.display =
    canViewVerification && isClaimInProgress ? 'block' : 'none';

  ownershipVerificationForm.style.display =
    isOwner && isClaimInProgress && !hasSubmittedAnswers ? 'block' : 'none';

  const existingReview = document.getElementById('verificationAnswersReview');
  if (existingReview) existingReview.remove();

  if (hasSubmittedAnswers && (isOwner || isVerifier)) {
    const review = document.createElement('div');
    review.id = 'verificationAnswersReview';
    review.style.cssText =
      'margin-top:12px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;';

    const heading = document.createElement('h4');
    heading.textContent = 'Submitted Ownership Verification Answers';
    heading.style.margin = '0 0 12px 0';
    review.appendChild(heading);

    answers.forEach((entry, index) => {
      const question = document.createElement('p');
      question.style.cssText = 'font-size:0.85rem;font-weight:700;margin:10px 0 4px;';
      question.textContent = `${index + 1}. ${entry.question}`;

      const answer = document.createElement('p');
      answer.style.cssText = 'font-size:0.85rem;margin:0;color:#334155;';
      answer.textContent = entry.answer;

      review.appendChild(question);
      review.appendChild(answer);
    });

    const submitted = document.createElement('p');
    submitted.style.cssText = 'font-size:0.75rem;color:#64748b;margin:12px 0 0;';
    submitted.textContent = match.verificationSubmittedAt
      ? `Submitted: ${formatDate(match.verificationSubmittedAt)}`
      : 'Answers submitted successfully.';

    review.appendChild(submitted);
    ownershipVerificationForm.insertAdjacentElement('afterend', review);
  } else if (isOwner && isClaimInProgress) {
    verificationFormMessage.textContent =
      'Please answer all three questions and submit them for verifier review.';
  }
}
    const verifierActionGroup = document.getElementById('verifierActionGroup');
    const approveVerificationBtn = document.getElementById('approveVerificationBtn');
    const rejectVerificationBtn = document.getElementById('rejectVerificationBtn');

    if (verifierActionGroup && approveVerificationBtn && rejectVerificationBtn) {
      if (isVerifier && match.status === 'CLAIM_IN_PROGRESS') {
        verifierActionGroup.style.display = 'inline-flex';
        approveVerificationBtn.disabled = false;
        approveVerificationBtn.textContent = '✓ Approve Verification';
        approveVerificationBtn.onclick = async () => {
          try {
            approveVerificationBtn.disabled = true;
            approveVerificationBtn.textContent = 'Approving…';
            const res = await API.request(`/api/matches/${match._id}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ status: 'VERIFIED', note: 'Ownership confirmed through Member 3 verification questions.' }),
            });
            match.status = 'VERIFIED';
            match.auditLog = res.match?.auditLog || match.auditLog;
            render();
            closeModal();
            showMessage('✓ Ownership claim verified successfully by Campus Verifier!', 'success');
          } catch (err) {
            alert('Approval error: ' + err.message);
            approveVerificationBtn.disabled = false;
            approveVerificationBtn.textContent = '✓ Approve Verification';
          }
        };

        rejectVerificationBtn.disabled = false;
        rejectVerificationBtn.textContent = '✕ Reject Claim';
        rejectVerificationBtn.onclick = async () => {
          const reason = prompt('Please enter the reason for rejecting this ownership claim:', 'Distinct identifying marks or questions did not match.');
          if (!reason) return;
          try {
            rejectVerificationBtn.disabled = true;
            rejectVerificationBtn.textContent = 'Rejecting…';
            const res = await API.request(`/api/matches/${match._id}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ status: 'REJECTED', rejectionReason: reason }),
            });
            match.status = 'REJECTED';
            match.auditLog = res.match?.auditLog || match.auditLog;
            render();
            closeModal();
            showMessage('Claim rejected and audit entry logged.', 'error');
          } catch (err) {
            alert('Rejection error: ' + err.message);
            rejectVerificationBtn.disabled = false;
            rejectVerificationBtn.textContent = '✕ Reject Claim';
          }
        };
      } else {
        verifierActionGroup.style.display = 'none';
      }
    }

    // Setup action button according to verification lifecycle
    if (match.status === 'RECLAIMED') {
      startVerificationBtn.textContent = '✓ Item Successfully Reclaimed';
      startVerificationBtn.disabled = true;
      startVerificationBtn.style.display = 'inline-flex';
      startVerificationBtn.classList.add('btn-outline');
    } else if (match.status === 'VERIFIED') {
      startVerificationBtn.textContent = 'Confirm Handover & Complete Recovery (Reclaim) →';
      startVerificationBtn.disabled = false;
      startVerificationBtn.style.display = 'inline-flex';
      startVerificationBtn.classList.remove('btn-outline');
      startVerificationBtn.onclick = async () => {
        if (!confirm('Confirm that the physical item has been handed over to the verified owner?')) return;
        try {
          startVerificationBtn.disabled = true;
          startVerificationBtn.textContent = 'Completing recovery…';
          const res = await API.request(`/api/matches/${match._id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'RECLAIMED', note: 'Handover complete. Belonging recovered.' }),
          });
          match.status = 'RECLAIMED';
          match.auditLog = res.match?.auditLog || match.auditLog;
          render();
          closeModal();
          showMessage('🏆 Item successfully reclaimed! Handover confirmed and reports updated.', 'success');
        } catch (err) {
          alert('Recovery error: ' + err.message);
          startVerificationBtn.disabled = false;
          startVerificationBtn.textContent = 'Confirm Handover & Complete Recovery (Reclaim) →';
        }
      };
    } else if (match.status === 'CLAIM_IN_PROGRESS') {
      if (isVerifier) {
        startVerificationBtn.style.display = 'none'; // Verifier uses approve/reject buttons
      } else {
        startVerificationBtn.style.display = 'inline-flex';
        startVerificationBtn.textContent = '⏳ Claim in Progress (Awaiting Campus Verifier Approval)';
        startVerificationBtn.disabled = true;
        startVerificationBtn.classList.add('btn-outline');
      }
    } else if (match.status === 'REJECTED') {
      startVerificationBtn.textContent = 'Claim Rejected by Verifier';
      startVerificationBtn.disabled = true;
      startVerificationBtn.style.display = 'inline-flex';
      startVerificationBtn.classList.add('btn-outline');
    } else {
      startVerificationBtn.textContent = 'Initiate Claim & Verify Ownership (Module 3) →';
      startVerificationBtn.disabled = false;
      startVerificationBtn.style.display = 'inline-flex';
      startVerificationBtn.classList.remove('btn-outline');
      startVerificationBtn.onclick = async () => {
        try {
          startVerificationBtn.disabled = true;
          startVerificationBtn.textContent = 'Initiating claim…';
          const res = await API.request(`/api/matches/${match._id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'CLAIM_IN_PROGRESS' }),
          });
          match.status = 'CLAIM_IN_PROGRESS';
          match.auditLog = res.match?.auditLog || match.auditLog;
          render();
          closeModal();
          showMessage('Claim started! Match status updated to "Claim in progress". Awaiting Member 3 Verifier review.', 'success');
        } catch (err) {
          alert('Could not start claim: ' + err.message);
          startVerificationBtn.disabled = false;
          startVerificationBtn.textContent = 'Initiate Claim & Verify Ownership (Module 3) →';
        }
      };
    }

    modal.classList.add('open');
  }

  function closeModal() {
    modal.classList.remove('open');
    selectedMatch = null;
  }

  closeModalBtn.addEventListener('click', closeModal);
  closeModalBtn2.addEventListener('click', closeModal);
  // Member 3: Submit ownership verification answers
if (ownershipVerificationForm) {
  ownershipVerificationForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!selectedMatch || !selectedMatch.isOwner) {
      alert('Only the item owner can submit verification answers.');
      return;
    }

    if (selectedMatch.status !== 'CLAIM_IN_PROGRESS') {
      alert('Please initiate the claim before submitting answers.');
      return;
    }

    const verificationAnswers = [
      {
        question: 'Describe a unique mark, scratch, sticker, or identifying feature of the item.',
        answer: document.getElementById('verificationAnswer1').value.trim(),
      },
      {
        question: 'Describe any contents, accessories, or attachments that belong with the item.',
        answer: document.getElementById('verificationAnswer2').value.trim(),
      },
      {
        question: 'Where and when did you last use or see the item?',
        answer: document.getElementById('verificationAnswer3').value.trim(),
      },
    ];

    if (verificationAnswers.some(entry => !entry.answer)) {
      verificationFormMessage.textContent = 'Please answer all three questions.';
      verificationFormMessage.style.color = '#dc2626';
      return;
    }

    try {
      submitVerificationAnswersBtn.disabled = true;
      submitVerificationAnswersBtn.textContent = 'Submitting...';

      const res = await API.request(
        `/api/matches/${selectedMatch._id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'CLAIM_IN_PROGRESS',
            verificationAnswers,
          }),
        }
      );

      if (!res.success || !res.match) {
        throw new Error(res.message || 'Could not submit verification answers.');
      }

      const updatedMatch = res.match;
      const index = allMatches.findIndex(m => m._id === updatedMatch._id);

      if (index !== -1) {
        allMatches[index] = updatedMatch;
      }

      selectedMatch = updatedMatch;
      openModal(updatedMatch);

      showMessage('Ownership verification answers submitted successfully!', 'success');

    } catch (err) {
      verificationFormMessage.textContent = err.message;
      verificationFormMessage.style.color = '#dc2626';

      submitVerificationAnswersBtn.disabled = false;
      submitVerificationAnswersBtn.textContent = 'Submit Verification Answers';
    }
  });
}
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  async function triggerRecalculate() {
    runAutoBtn.disabled = true;
    runAutoBtn.textContent = 'Running algorithm…';
    try {
      const res = await API.request('/api/matches/recalculate', { method: 'POST' });
      showMessage(`⚡ ${res.message} Total matches available: ${res.totalMatches}.`, 'success');
      await loadMatches();
    } catch (err) {
      showMessage(`Matching error: ${err.message}`, 'error');
    } finally {
      runAutoBtn.disabled = false;
      runAutoBtn.textContent = '⚡ Run Auto-Match';
    }
  }

  function showMessage(text, type = 'success') {
    messageBox.textContent = text;
    messageBox.className = `message ${type}`;
    messageBox.style.display = 'block';
    setTimeout(() => {
      messageBox.style.display = 'none';
    }, 5000);
  }

  // Filter change handlers
  searchInput.addEventListener('input', render);
  categoryFilter.addEventListener('change', render);
  scoreFilter.addEventListener('change', render);
  statusFilter.addEventListener('change', render);
  runAutoBtn.addEventListener('click', triggerRecalculate);

  // Initial load
  loadMatches();
});
