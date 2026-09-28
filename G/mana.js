const pages = [...document.querySelectorAll('[data-page]')];
const navigationLinks = [...document.querySelectorAll('[data-nav]')];
const reservationForm = document.querySelector('#reservation-form');
const purchaseForm = document.querySelector('#purchase-form');
const loginForm = document.querySelector('#login-form');
const dashboard = document.querySelector('#admin-dashboard');
const loginError = document.querySelector('#login-error');
const dashboardError = document.querySelector('#dashboard-error');
const tableHead = document.querySelector('#table-head');
const tableBody = document.querySelector('#table-body');
const emptyState = document.querySelector('#empty-state');
let activeList = 'reservations';
let adminData = { reservations: [], purchases: [] };
const cfaFormatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'XOF', maximumFractionDigits: 0 });

function formatCfa(value) {
	return cfaFormatter.format(Number(value));
}

document.querySelectorAll('[data-price]').forEach((element) => {
	const suffix = element.querySelector('span');
	const formattedPrice = formatCfa(element.dataset.price);
	element.textContent = formattedPrice;
	if (suffix) element.append(suffix);
});

function showPage(pageName) {
	const page = pages.find((item) => item.dataset.page === pageName) ?? pages[0];
	pages.forEach((item) => { item.hidden = item !== page; });
	navigationLinks.forEach((link) => {
		const isActive = link.dataset.nav === page.dataset.page;
		link.classList.toggle('is-active', isActive);
		if (isActive) link.setAttribute('aria-current', 'page');
		else link.removeAttribute('aria-current');
	});
	window.scrollTo({ top: 0, behavior: 'smooth' });
	if (page.dataset.page === 'administration') checkAdminSession();
}

function navigate() {
	const requestedPage = window.location.hash.slice(1) || 'accueil';
	showPage(pages.some((page) => page.dataset.page === requestedPage) ? requestedPage : 'accueil');
}

async function sendRequest(path, body) {
	const response = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(result.error || 'Une erreur est survenue. Réessayez.');
	return result;
}

function formValues(form) {
	return Object.fromEntries(new FormData(form).entries());
}

function showFormError(element, message = '') {
	element.textContent = message;
	element.hidden = !message;
}

function showConfirmation(firstName, message) {
	document.querySelector('#confirmation-name').textContent = `${firstName}, à bientôt.`;
	document.querySelector('#confirmation-copy').textContent = message;
	window.location.hash = 'confirmation';
}

reservationForm.addEventListener('submit', async (event) => {
	event.preventDefault();
	const button = reservationForm.querySelector('[type="submit"]');
	const error = document.querySelector('#reservation-error');
	const values = formValues(reservationForm);
	button.disabled = true;
	showFormError(error);
	try {
		await sendRequest('/api/reservations', values);
		reservationForm.reset();
		showConfirmation(values.firstName, 'Votre demande de réservation a bien été transmise. La salle vous contactera pour confirmer le créneau.');
	} catch (requestError) {
		showFormError(error, requestError.message);
	} finally {
		button.disabled = false;
	}
});

purchaseForm.addEventListener('submit', async (event) => {
	event.preventDefault();
	const button = purchaseForm.querySelector('[type="submit"]');
	const error = document.querySelector('#purchase-error');
	const values = formValues(purchaseForm);
	button.disabled = true;
	showFormError(error);
	try {
		const order = await sendRequest('/api/purchases', values);
		purchaseForm.reset();
		showConfirmation(values.firstName, `Votre commande (${order.product}, ${formatCfa(order.total)}) a bien été transmise. La salle vous contactera pour finaliser l’achat.`);
	} catch (requestError) {
		showFormError(error, requestError.message);
	} finally {
		button.disabled = false;
	}
});

function appendCell(row, value) {
	const cell = document.createElement('td');
	cell.textContent = value ?? '—';
	row.append(cell);
}

function renderAdminList() {
	const isReservation = activeList === 'reservations';
	const records = adminData[activeList];
	const headers = isReservation
		? ['Client', 'Âge', 'E-mail', 'Activité', 'Créneau', 'Reçue le']
		: ['Client', 'Âge', 'E-mail', 'Article', 'Qté', 'Total', 'Reçue le'];
	tableHead.replaceChildren();
	tableBody.replaceChildren();
	const headerRow = document.createElement('tr');
	headers.forEach((label) => {
		const cell = document.createElement('th');
		cell.scope = 'col';
		cell.textContent = label;
		headerRow.append(cell);
	});
	tableHead.append(headerRow);
	records.forEach((record) => {
		const row = document.createElement('tr');
		appendCell(row, `${record.firstName} ${record.lastName}`);
		appendCell(row, `${record.age} ans`);
		appendCell(row, record.email);
		if (isReservation) {
			appendCell(row, record.service);
			appendCell(row, `${record.date} · ${record.time}`);
		} else {
			appendCell(row, record.productName);
			appendCell(row, String(record.quantity));
			appendCell(row, formatCfa(record.total));
		}
		appendCell(row, new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.createdAt)));
		tableBody.append(row);
	});
	emptyState.hidden = records.length > 0;
	document.querySelector('#reservation-count').textContent = String(adminData.reservations.length);
	document.querySelector('#purchase-count').textContent = String(adminData.purchases.length);
}

async function loadAdminData() {
	const response = await fetch('/api/admin/requests', { credentials: 'same-origin' });
	if (response.status === 401) {
		loginForm.hidden = false;
		dashboard.hidden = true;
		return false;
	}
	if (!response.ok) throw new Error('Impossible de charger les demandes.');
	adminData = await response.json();
	loginForm.hidden = true;
	dashboard.hidden = false;
	renderAdminList();
	return true;
}

async function checkAdminSession() {
	try {
		await loadAdminData();
	} catch (error) {
		loginForm.hidden = false;
		dashboard.hidden = true;
		showFormError(dashboardError, error.message);
	}
}

loginForm.addEventListener('submit', async (event) => {
	event.preventDefault();
	const button = loginForm.querySelector('[type="submit"]');
	button.disabled = true;
	showFormError(loginError);
	try {
		await sendRequest('/api/admin/login', formValues(loginForm));
		loginForm.reset();
		showFormError(dashboardError);
		await loadAdminData();
	} catch (error) {
		showFormError(loginError, error.message);
	} finally {
		button.disabled = false;
	}
});

document.querySelector('#logout-button').addEventListener('click', async () => {
	try {
		await sendRequest('/api/admin/logout', {});
		dashboard.hidden = true;
		loginForm.hidden = false;
	} catch (error) {
		showFormError(dashboardError, error.message);
	}
});

document.querySelectorAll('.dashboard-tab').forEach((tab) => {
	tab.addEventListener('click', () => {
		activeList = tab.dataset.list;
		document.querySelectorAll('.dashboard-tab').forEach((item) => {
			const selected = item === tab;
			item.classList.toggle('is-active', selected);
			item.setAttribute('aria-selected', String(selected));
		});
		renderAdminList();
	});
});

document.querySelectorAll('[data-plan]').forEach((link) => {
	link.addEventListener('click', () => {
		const service = document.querySelector('[name="service"]');
		if (service) service.value = link.dataset.plan;
	});
});

window.addEventListener('hashchange', navigate);
navigate();
