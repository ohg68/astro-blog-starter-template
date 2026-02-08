// ============================================================
// Trip Cost & Efficiency Analytics - Application Logic
// ============================================================

// --- Global State ---
let map, routeLayer;
let costChart;
let lastCalculations = null;
let originCoords = null;
let destinationCoords = null;
let lastOSRMDistanceKm = null; // Real road distance from OSRM

// --- Nominatim Rate Limiter ---
// Nominatim requires max 1 request/second and a valid User-Agent
const NominatimThrottle = {
    lastRequestTime: 0,
    minInterval: 1100, // 1.1s between requests

    async throttledFetch(url) {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minInterval) {
            await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
        }
        this.lastRequestTime = Date.now();
        return fetch(url, {
            headers: {
                'Accept': 'application/json'
            }
        });
    }
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', function () {
    initializeMap();
    loadLastRoute();
    setupEventListeners();
});

function initializeMap() {
    map = L.map('map').setView([40.4168, -3.7038], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);

    routeLayer = L.layerGroup().addTo(map);
}

function loadLastRoute() {
    try {
        const lastRoute = localStorage.getItem('lastRoute');
        if (lastRoute) {
            const routeData = JSON.parse(lastRoute);
            document.getElementById('origin').value = routeData.origin || 'Madrid, España';
            document.getElementById('destination').value = routeData.destination || 'Barcelona, España';
        }
    } catch (e) {
        // localStorage not available (e.g. private browsing) — silently ignore
        console.warn('localStorage not available:', e.message);
    }
}

function saveCurrentRoute() {
    try {
        const routeData = {
            origin: document.getElementById('origin').value,
            destination: document.getElementById('destination').value,
            timestamp: new Date().toISOString()
        };
        localStorage.setItem('lastRoute', JSON.stringify(routeData));
    } catch (e) {
        console.warn('Could not save route to localStorage:', e.message);
    }
}

function setupEventListeners() {
    document.getElementById('calculateBtn').addEventListener('click', calculateAllCosts);
    document.getElementById('exportBtn').addEventListener('click', generatePDF);
}

// --- Input Validation ---
function validatePositiveNumber(value, fieldName) {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0) {
        return { valid: false, value: 0, error: `${fieldName} debe ser un número positivo` };
    }
    return { valid: true, value: num, error: null };
}

function validateInputs() {
    const errors = [];
    const fields = [
        { id: 'fuelConsumption', name: 'Consumo de combustible', min: 0.1 },
        { id: 'fuelPrice', name: 'Precio de combustible', min: 0.01 },
        { id: 'tolls', name: 'Peajes', min: 0 },
        { id: 'planePrice', name: 'Precio de avión', min: 0 },
        { id: 'trainPrice', name: 'Precio de tren', min: 0 },
        { id: 'busPrice', name: 'Precio de autobús', min: 0 },
        { id: 'transfers', name: 'Traslados', min: 0 },
        { id: 'hotelPrice', name: 'Precio de hotel', min: 0 }
    ];

    // Clear previous validation marks
    fields.forEach(f => document.getElementById(f.id).classList.remove('invalid'));

    for (const field of fields) {
        const el = document.getElementById(field.id);
        const val = parseFloat(el.value);
        if (isNaN(val) || val < field.min) {
            el.classList.add('invalid');
            errors.push(`${field.name} debe ser al menos ${field.min}`);
        }
    }

    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();
    if (!origin) errors.push('Introduce un origen');
    if (!destination) errors.push('Introduce un destino');

    return errors;
}

// --- Text Sanitization ---
function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// --- Price Estimation Models ---

/**
 * Estimate train ticket price based on distance.
 * Uses average pricing data from Spanish rail operators (Renfe AVE / Media Distancia).
 * Returns { min, avg, max } per person.
 */
function estimateTrainPrice(distanceKm) {
    if (distanceKm < 50) {
        return { min: 5, avg: distanceKm * 0.12, max: distanceKm * 0.18 };
    } else if (distanceKm < 150) {
        return { min: distanceKm * 0.06, avg: distanceKm * 0.10, max: distanceKm * 0.15 };
    } else if (distanceKm < 400) {
        return { min: distanceKm * 0.06, avg: distanceKm * 0.09, max: distanceKm * 0.14 };
    } else {
        return { min: distanceKm * 0.05, avg: distanceKm * 0.08, max: distanceKm * 0.12 };
    }
}

/**
 * Estimate bus ticket price based on distance.
 * Uses average pricing data from Spanish bus operators (ALSA, Avanza).
 * Returns { min, avg, max } per person.
 */
function estimateBusPrice(distanceKm) {
    if (distanceKm < 50) {
        return { min: 3, avg: distanceKm * 0.08, max: distanceKm * 0.12 };
    } else if (distanceKm < 150) {
        return { min: distanceKm * 0.04, avg: distanceKm * 0.07, max: distanceKm * 0.10 };
    } else if (distanceKm < 400) {
        return { min: distanceKm * 0.03, avg: distanceKm * 0.05, max: distanceKm * 0.08 };
    } else {
        return { min: distanceKm * 0.025, avg: distanceKm * 0.045, max: distanceKm * 0.07 };
    }
}

/**
 * Estimate plane ticket price based on distance.
 * Returns { min, avg, max } per person.
 */
function estimatePlanePrice(distanceKm) {
    if (distanceKm < 300) {
        // Short-haul: often not worth flying
        return { min: 30, avg: 55, max: 90 };
    } else if (distanceKm < 800) {
        return { min: 25 + distanceKm * 0.05, avg: 40 + distanceKm * 0.08, max: 60 + distanceKm * 0.15 };
    } else {
        return { min: 40 + distanceKm * 0.04, avg: 60 + distanceKm * 0.07, max: 90 + distanceKm * 0.12 };
    }
}

// --- Main Calculation ---
async function calculateAllCosts() {
    // Validate inputs
    const errors = validateInputs();
    if (errors.length > 0) {
        showNotification('Corrige los campos marcados: ' + errors[0], 'error');
        return;
    }

    // Disable button during calculation
    const btn = document.getElementById('calculateBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculando...';

    showNotification('Calculando rutas y costos...', 'info');
    saveCurrentRoute();

    // Read input values
    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();
    const people = Math.max(1, parseInt(document.getElementById('people').value) || 1);
    const nights = Math.max(0, parseInt(document.getElementById('nights').value) || 0);

    const fuelConsumption = parseFloat(document.getElementById('fuelConsumption').value) || 6.5;
    const fuelPrice = parseFloat(document.getElementById('fuelPrice').value) || 1.55;
    const tolls = parseFloat(document.getElementById('tolls').value) || 0;

    const userPlanePrice = parseFloat(document.getElementById('planePrice').value);
    const userTrainPrice = parseFloat(document.getElementById('trainPrice').value);
    const userBusPrice = parseFloat(document.getElementById('busPrice').value);
    const transfers = parseFloat(document.getElementById('transfers').value) || 20;

    const hotelPrice = parseFloat(document.getElementById('hotelPrice').value) || 80;

    showMapLoading(true);
    lastOSRMDistanceKm = null;

    try {
        // Geocode both locations (throttled)
        originCoords = await geocodeLocation(origin);
        destinationCoords = await geocodeLocation(destination);

        if (!originCoords || !destinationCoords) {
            throw new Error('No se pudieron obtener las coordenadas de las ubicaciones');
        }

        // Update map and get real road distance from OSRM
        await updateMapRoute(originCoords, destinationCoords, origin, destination);

        // Distances
        const straightDistance = calculateHaversineDistance(originCoords, destinationCoords);
        const airDistance = straightDistance * 1.15; // Flight path overhead
        const roadDistance = lastOSRMDistanceKm || (straightDistance * 1.3); // Use OSRM if available

        // Estimate prices if user left defaults or set 0
        const trainEstimate = estimateTrainPrice(roadDistance);
        const busEstimate = estimateBusPrice(roadDistance);
        const planeEstimate = estimatePlanePrice(airDistance);

        // Use user-provided price if they changed it, otherwise use estimated average
        const effectiveTrainPrice = (userTrainPrice > 0) ? userTrainPrice : trainEstimate.avg;
        const effectiveBusPrice = (userBusPrice > 0) ? userBusPrice : busEstimate.avg;
        const effectivePlanePrice = (userPlanePrice > 0) ? userPlanePrice : planeEstimate.avg;

        // Update input fields with estimates if they were 0
        if (!(userTrainPrice > 0)) document.getElementById('trainPrice').value = effectiveTrainPrice.toFixed(2);
        if (!(userBusPrice > 0)) document.getElementById('busPrice').value = effectiveBusPrice.toFixed(2);
        if (!(userPlanePrice > 0)) document.getElementById('planePrice').value = effectivePlanePrice.toFixed(2);

        // Calculate costs
        const carCalc = calculateCarCost(roadDistance, fuelConsumption, fuelPrice, tolls, people);
        const planeCalc = calculatePublicTransportCost(airDistance, effectivePlanePrice, transfers, people);
        const trainCalc = calculatePublicTransportCost(roadDistance, effectiveTrainPrice, transfers, people);
        const busCalc = calculatePublicTransportCost(roadDistance, effectiveBusPrice, transfers, people);

        // CO2 emissions (per vehicle / per person correctly)
        const emissions = calculateEmissions(roadDistance, airDistance, people);

        // Accommodation
        const accommodationCost = nights * hotelPrice;

        // Update UI
        updateUIWithResults(
            carCalc, planeCalc, trainCalc, busCalc,
            roadDistance, airDistance, emissions, accommodationCost,
            { train: trainEstimate, bus: busEstimate, plane: planeEstimate },
            people
        );
        showMostEfficientOption(carCalc, planeCalc, trainCalc, busCalc);
        updateChart(carCalc, planeCalc, trainCalc, busCalc);
        updateRealCost(carCalc, planeCalc, trainCalc, busCalc, accommodationCost);

        // Save for PDF
        lastCalculations = {
            car: carCalc,
            plane: planeCalc,
            train: trainCalc,
            bus: busCalc,
            roadDistance,
            airDistance,
            emissions,
            accommodationCost,
            origin,
            destination,
            people,
            nights,
            hotelPrice,
            estimates: { train: trainEstimate, bus: busEstimate, plane: planeEstimate },
            usedOSRM: lastOSRMDistanceKm !== null
        };

        showNotification('Cálculos completados correctamente.', 'success');
    } catch (error) {
        console.error('Error en los cálculos:', error);
        showNotification('Error al calcular la ruta. Verifica las ubicaciones.', 'error');
    } finally {
        showMapLoading(false);
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-chart-bar"></i> Calcular y Comparar';
    }
}

// --- Geocoding ---
async function geocodeLocation(location) {
    try {
        const response = await NominatimThrottle.throttledFetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`
        );

        if (!response.ok) {
            throw new Error(`Geocoding HTTP error: ${response.status}`);
        }

        const data = await response.json();

        if (data && data.length > 0) {
            return {
                lat: parseFloat(data[0].lat),
                lon: parseFloat(data[0].lon),
                displayName: data[0].display_name
            };
        } else {
            console.warn(`No results for: ${location}`);
            return getDefaultCoordinates(location);
        }
    } catch (error) {
        console.error('Geocoding error:', error);
        return getDefaultCoordinates(location);
    }
}

function getDefaultCoordinates(location) {
    const cityCoordinates = {
        "madrid": { lat: 40.4168, lon: -3.7038, displayName: "Madrid, España" },
        "barcelona": { lat: 41.3851, lon: 2.1734, displayName: "Barcelona, España" },
        "valencia": { lat: 39.4699, lon: -0.3763, displayName: "Valencia, España" },
        "sevilla": { lat: 37.3891, lon: -5.9845, displayName: "Sevilla, España" },
        "bilbao": { lat: 43.2630, lon: -2.9350, displayName: "Bilbao, España" },
        "malaga": { lat: 36.7194, lon: -4.4200, displayName: "Málaga, España" },
        "zaragoza": { lat: 41.6488, lon: -0.8891, displayName: "Zaragoza, España" },
        "alicante": { lat: 38.3452, lon: -0.4810, displayName: "Alicante, España" },
        "paris": { lat: 48.8566, lon: 2.3522, displayName: "Paris, France" },
        "lisboa": { lat: 38.7223, lon: -9.1393, displayName: "Lisboa, Portugal" },
        "london": { lat: 51.5074, lon: -0.1278, displayName: "London, UK" }
    };

    const locationLower = location.toLowerCase();
    for (const [city, coords] of Object.entries(cityCoordinates)) {
        if (locationLower.includes(city)) {
            return coords;
        }
    }

    return cityCoordinates.madrid;
}

// --- Distance Calculations ---

/**
 * Pure Haversine distance (straight line, no margins).
 */
function calculateHaversineDistance(coord1, coord2) {
    const R = 6371;
    const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
    const dLon = (coord2.lon - coord1.lon) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// --- Map ---
async function updateMapRoute(originCoords, destinationCoords, originName, destinationName) {
    routeLayer.clearLayers();

    L.marker([originCoords.lat, originCoords.lon]).addTo(routeLayer)
        .bindPopup(`<b>Origen:</b> ${escapeHTML(originName)}`)
        .openPopup();

    L.marker([destinationCoords.lat, destinationCoords.lon]).addTo(routeLayer)
        .bindPopup(`<b>Destino:</b> ${escapeHTML(destinationName)}`);

    try {
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originCoords.lon},${originCoords.lat};${destinationCoords.lon},${destinationCoords.lat}?overview=full&geometries=geojson`;

        const response = await fetch(osrmUrl);
        if (response.ok) {
            const data = await response.json();

            if (data.routes && data.routes.length > 0) {
                const route = data.routes[0];
                const routeCoordinates = route.geometry.coordinates.map(coord => [coord[1], coord[0]]);

                // Store real road distance from OSRM
                lastOSRMDistanceKm = route.distance / 1000;

                L.polyline(routeCoordinates, {
                    color: '#0ea5e9',
                    weight: 4,
                    opacity: 0.7,
                    lineJoin: 'round'
                }).addTo(routeLayer);

                const midLat = (originCoords.lat + destinationCoords.lat) / 2;
                const midLon = (originCoords.lon + destinationCoords.lon) / 2;
                L.popup()
                    .setLatLng([midLat, midLon])
                    .setContent(`<b>Distancia por carretera:</b> ${lastOSRMDistanceKm.toFixed(1)} km<br><small>(fuente: OSRM)</small>`)
                    .openOn(map);
            } else {
                drawStraightRoute(originCoords, destinationCoords);
            }
        } else {
            drawStraightRoute(originCoords, destinationCoords);
        }
    } catch (error) {
        console.warn('OSRM route error, using straight line:', error);
        drawStraightRoute(originCoords, destinationCoords);
    }

    const bounds = L.latLngBounds(
        [originCoords.lat, originCoords.lon],
        [destinationCoords.lat, destinationCoords.lon]
    );
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
}

function drawStraightRoute(originCoords, destinationCoords) {
    L.polyline([
        [originCoords.lat, originCoords.lon],
        [destinationCoords.lat, destinationCoords.lon]
    ], {
        color: '#0ea5e9',
        weight: 4,
        opacity: 0.7,
        dashArray: '10, 10'
    }).addTo(routeLayer);
}

// --- Cost Calculations ---
function calculateCarCost(distance, consumption, fuelPrice, tolls, people) {
    const fuelCost = (distance / 100) * consumption * fuelPrice;
    const maintenanceCost = distance * 0.05;
    const totalCost = fuelCost + tolls + maintenanceCost;
    const costPerPerson = totalCost / people;
    const costPerPersonKm = distance > 0 ? costPerPerson / distance : 0;

    return {
        fuelCost,
        tolls,
        maintenanceCost,
        totalCost,
        costPerPerson,
        costPerPersonKm,
        distance
    };
}

function calculatePublicTransportCost(distance, ticketPrice, transfers, people) {
    const ticketsCost = ticketPrice * people;
    const totalCost = ticketsCost + transfers;
    const costPerPerson = totalCost / people;
    const costPerPersonKm = distance > 0 ? costPerPerson / distance : 0;

    return {
        ticketsCost,
        transfers,
        totalCost,
        costPerPerson,
        costPerPersonKm,
        distance
    };
}

// --- CO2 Emissions ---
/**
 * Calculate CO2 emissions correctly:
 * - Car: emissions are per VEHICLE (shared among passengers)
 * - Plane/Train/Bus: emissions are per PASSENGER
 * Factors from European Environment Agency (EEA).
 */
function calculateEmissions(roadDistance, airDistance, people) {
    const carEmissionPerKm = 0.17;    // kg CO2/km for average car (vehicle total)
    const planeEmissionPerPaxKm = 0.25;  // kg CO2/passenger/km
    const trainEmissionPerPaxKm = 0.035; // kg CO2/passenger/km
    const busEmissionPerPaxKm = 0.03;    // kg CO2/passenger/km

    return {
        // Car: total vehicle emissions (independent of passengers)
        car: {
            total: roadDistance * carEmissionPerKm,
            perPerson: (roadDistance * carEmissionPerKm) / people
        },
        // Public transport: per-passenger emissions
        plane: {
            total: airDistance * planeEmissionPerPaxKm * people,
            perPerson: airDistance * planeEmissionPerPaxKm
        },
        train: {
            total: roadDistance * trainEmissionPerPaxKm * people,
            perPerson: roadDistance * trainEmissionPerPaxKm
        },
        bus: {
            total: roadDistance * busEmissionPerPaxKm * people,
            perPerson: roadDistance * busEmissionPerPaxKm
        }
    };
}

// --- UI Updates ---
function updateUIWithResults(car, plane, train, bus, roadDistance, airDistance, emissions, accommodationCost, estimates, people) {
    const distanceSource = lastOSRMDistanceKm !== null ? ' (OSRM)' : ' (estimada)';

    // Car
    document.getElementById('carCost').textContent = `€${car.totalCost.toFixed(2)}`;
    document.getElementById('carCostPerKm').textContent = `€${car.costPerPersonKm.toFixed(4)} por persona/km`;
    document.getElementById('carFuel').textContent = `€${car.fuelCost.toFixed(2)}`;
    document.getElementById('carTolls').textContent = `€${car.tolls.toFixed(2)}`;
    document.getElementById('carMaintenance').textContent = `€${car.maintenanceCost.toFixed(2)}`;
    document.getElementById('carDistance').textContent = `${roadDistance.toFixed(0)} km${distanceSource}`;

    // Plane
    document.getElementById('planeCost').textContent = `€${plane.totalCost.toFixed(2)}`;
    document.getElementById('planeCostPerKm').textContent = `€${plane.costPerPersonKm.toFixed(4)} por persona/km`;
    document.getElementById('planeTickets').textContent = `€${plane.ticketsCost.toFixed(2)}`;
    document.getElementById('planeTransfers').textContent = `€${plane.transfers.toFixed(2)}`;
    document.getElementById('planeDistance').textContent = `${airDistance.toFixed(0)} km`;
    document.getElementById('planePriceRange').textContent =
        `Rango estimado: €${estimates.plane.min.toFixed(0)} - €${estimates.plane.max.toFixed(0)} por persona`;

    // Train
    document.getElementById('trainCost').textContent = `€${train.totalCost.toFixed(2)}`;
    document.getElementById('trainCostPerKm').textContent = `€${train.costPerPersonKm.toFixed(4)} por persona/km`;
    document.getElementById('trainTickets').textContent = `€${train.ticketsCost.toFixed(2)}`;
    document.getElementById('trainTransfers').textContent = `€${train.transfers.toFixed(2)}`;
    document.getElementById('trainDistance').textContent = `${roadDistance.toFixed(0)} km${distanceSource}`;
    document.getElementById('trainPriceRange').textContent =
        `Rango estimado: €${estimates.train.min.toFixed(0)} - €${estimates.train.max.toFixed(0)} por persona`;

    // Bus
    document.getElementById('busCost').textContent = `€${bus.totalCost.toFixed(2)}`;
    document.getElementById('busCostPerKm').textContent = `€${bus.costPerPersonKm.toFixed(4)} por persona/km`;
    document.getElementById('busTickets').textContent = `€${bus.ticketsCost.toFixed(2)}`;
    document.getElementById('busTransfers').textContent = `€${bus.transfers.toFixed(2)}`;
    document.getElementById('busDistance').textContent = `${roadDistance.toFixed(0)} km${distanceSource}`;
    document.getElementById('busPriceRange').textContent =
        `Rango estimado: €${estimates.bus.min.toFixed(0)} - €${estimates.bus.max.toFixed(0)} por persona`;

    // Emissions (show total + per person)
    document.getElementById('carEmission').textContent = `${emissions.car.total.toFixed(1)} kg`;
    document.getElementById('carEmissionPerPerson').textContent = `(${emissions.car.perPerson.toFixed(1)} kg/persona)`;
    document.getElementById('planeEmission').textContent = `${emissions.plane.total.toFixed(1)} kg`;
    document.getElementById('planeEmissionPerPerson').textContent = `(${emissions.plane.perPerson.toFixed(1)} kg/persona)`;
    document.getElementById('trainEmission').textContent = `${emissions.train.total.toFixed(1)} kg`;
    document.getElementById('trainEmissionPerPerson').textContent = `(${emissions.train.perPerson.toFixed(1)} kg/persona)`;
    document.getElementById('busEmission').textContent = `${emissions.bus.total.toFixed(1)} kg`;
    document.getElementById('busEmissionPerPerson').textContent = `(${emissions.bus.perPerson.toFixed(1)} kg/persona)`;
}

function showMostEfficientOption(car, plane, train, bus) {
    const badges = ['carBadge', 'planeBadge', 'trainBadge', 'busBadge'];
    badges.forEach(id => document.getElementById(id).style.display = 'none');

    const costs = [
        { id: 'carBadge', value: car.costPerPersonKm },
        { id: 'planeBadge', value: plane.costPerPersonKm },
        { id: 'trainBadge', value: train.costPerPersonKm },
        { id: 'busBadge', value: bus.costPerPersonKm }
    ];

    costs.sort((a, b) => a.value - b.value);
    document.getElementById(costs[0].id).style.display = 'block';
}

function updateChart(car, plane, train, bus) {
    const ctx = document.getElementById('costChart').getContext('2d');

    if (costChart) {
        costChart.destroy();
    }

    costChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Coche', 'Avión', 'Tren', 'Autobús'],
            datasets: [{
                label: 'Costo Total (€)',
                data: [car.totalCost, plane.totalCost, train.totalCost, bus.totalCost],
                backgroundColor: [
                    'rgba(16, 185, 129, 0.8)',
                    'rgba(14, 165, 233, 0.8)',
                    'rgba(245, 158, 11, 0.8)',
                    'rgba(139, 92, 246, 0.8)'
                ],
                borderColor: [
                    'rgb(16, 185, 129)',
                    'rgb(14, 165, 233)',
                    'rgb(245, 158, 11)',
                    'rgb(139, 92, 246)'
                ],
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            return `Costo total: €${context.raw.toFixed(2)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255, 255, 255, 0.1)' },
                    ticks: {
                        color: '#cbd5e1',
                        callback: function (value) { return '€' + value; }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#cbd5e1' }
                }
            }
        }
    });
}

function updateRealCost(car, plane, train, bus, accommodationCost) {
    const totalCar = car.totalCost + accommodationCost;
    const totalPlane = plane.totalCost + accommodationCost;
    const totalTrain = train.totalCost + accommodationCost;
    const totalBus = bus.totalCost + accommodationCost;
    const minCost = Math.min(totalCar, totalPlane, totalTrain, totalBus);

    document.getElementById('realCostDisplay').innerHTML = `
        <strong>Incluye alojamiento:</strong><br>
        Coche: €${totalCar.toFixed(2)} | Avión: €${totalPlane.toFixed(2)}<br>
        Tren: €${totalTrain.toFixed(2)} | Autobús: €${totalBus.toFixed(2)}<br>
        <span style="color: var(--accent-green); margin-top: 5px; display: inline-block;">
            Opción más económica con alojamiento: €${minCost.toFixed(2)}
        </span>
    `;
}

// --- Map Loading ---
function showMapLoading(show) {
    const el = document.getElementById('mapLoading');
    if (show) {
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

// --- PDF Generation (real jsPDF) ---
function generatePDF() {
    const userName = document.getElementById('userName').value.trim();
    const userEmail = document.getElementById('userEmail').value.trim();

    if (!userName) {
        showNotification('Por favor, introduce tu nombre antes de generar el PDF.', 'error');
        return;
    }

    if (!lastCalculations) {
        showNotification('Primero debes calcular los costos del viaje.', 'error');
        return;
    }

    showNotification('Generando PDF...', 'info');

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const calc = lastCalculations;
        let y = 20;
        const leftMargin = 20;
        const pageWidth = 170;

        // Title
        doc.setFontSize(18);
        doc.setTextColor(14, 165, 233);
        doc.text('Trip Cost & Efficiency Analytics', leftMargin, y);
        y += 10;

        // Subtitle
        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text(`Generado para: ${userName}  |  Fecha: ${new Date().toLocaleDateString('es-ES')}`, leftMargin, y);
        if (userEmail) {
            y += 5;
            doc.text(`Email: ${userEmail}`, leftMargin, y);
        }
        y += 10;

        // Route info
        doc.setDrawColor(14, 165, 233);
        doc.line(leftMargin, y, leftMargin + pageWidth, y);
        y += 8;

        doc.setFontSize(13);
        doc.setTextColor(30);
        doc.text('Datos del Viaje', leftMargin, y);
        y += 8;

        doc.setFontSize(10);
        doc.setTextColor(60);
        const routeLines = [
            `Origen: ${calc.origin}`,
            `Destino: ${calc.destination}`,
            `Distancia carretera: ${calc.roadDistance.toFixed(0)} km${calc.usedOSRM ? ' (OSRM)' : ' (estimada)'}`,
            `Distancia aérea: ${calc.airDistance.toFixed(0)} km`,
            `Personas: ${calc.people}  |  Noches: ${calc.nights}  |  Hotel/noche: €${calc.hotelPrice.toFixed(2)}`,
            `Alojamiento total: €${calc.accommodationCost.toFixed(2)}`
        ];
        routeLines.forEach(line => {
            doc.text(line, leftMargin, y);
            y += 6;
        });
        y += 4;

        // Transport comparison
        doc.setFontSize(13);
        doc.setTextColor(30);
        doc.text('Comparativa de Costos', leftMargin, y);
        y += 8;

        const transports = [
            {
                name: 'Coche', data: calc.car, color: [16, 185, 129],
                details: `Combustible: €${calc.car.fuelCost.toFixed(2)} | Peajes: €${calc.car.tolls.toFixed(2)} | Mant.: €${calc.car.maintenanceCost.toFixed(2)}`
            },
            {
                name: 'Avión', data: calc.plane, color: [14, 165, 233],
                details: `Billetes: €${calc.plane.ticketsCost.toFixed(2)} | Traslados: €${calc.plane.transfers.toFixed(2)} | Rango: €${calc.estimates.plane.min.toFixed(0)}-€${calc.estimates.plane.max.toFixed(0)}/pers`
            },
            {
                name: 'Tren', data: calc.train, color: [245, 158, 11],
                details: `Billetes: €${calc.train.ticketsCost.toFixed(2)} | Traslados: €${calc.train.transfers.toFixed(2)} | Rango: €${calc.estimates.train.min.toFixed(0)}-€${calc.estimates.train.max.toFixed(0)}/pers`
            },
            {
                name: 'Autobús', data: calc.bus, color: [139, 92, 246],
                details: `Billetes: €${calc.bus.ticketsCost.toFixed(2)} | Traslados: €${calc.bus.transfers.toFixed(2)} | Rango: €${calc.estimates.bus.min.toFixed(0)}-€${calc.estimates.bus.max.toFixed(0)}/pers`
            }
        ];

        doc.setFontSize(10);
        transports.forEach(t => {
            if (y > 260) {
                doc.addPage();
                y = 20;
            }
            doc.setTextColor(...t.color);
            doc.text(`${t.name}: €${t.data.totalCost.toFixed(2)}  (€${t.data.costPerPersonKm.toFixed(4)}/pers/km)`, leftMargin, y);
            y += 5;
            doc.setTextColor(100);
            doc.text(t.details, leftMargin + 5, y);
            y += 8;
        });

        y += 4;

        // Emissions
        if (y > 240) {
            doc.addPage();
            y = 20;
        }

        doc.setFontSize(13);
        doc.setTextColor(30);
        doc.text('Huella de Carbono (CO2)', leftMargin, y);
        y += 8;

        doc.setFontSize(10);
        doc.setTextColor(60);
        const emissionLines = [
            `Coche: ${calc.emissions.car.total.toFixed(1)} kg total (${calc.emissions.car.perPerson.toFixed(1)} kg/persona)`,
            `Avión: ${calc.emissions.plane.total.toFixed(1)} kg total (${calc.emissions.plane.perPerson.toFixed(1)} kg/persona)`,
            `Tren: ${calc.emissions.train.total.toFixed(1)} kg total (${calc.emissions.train.perPerson.toFixed(1)} kg/persona)`,
            `Autobús: ${calc.emissions.bus.total.toFixed(1)} kg total (${calc.emissions.bus.perPerson.toFixed(1)} kg/persona)`
        ];
        emissionLines.forEach(line => {
            doc.text(line, leftMargin, y);
            y += 6;
        });

        y += 6;

        // Summary with accommodation
        const totalCosts = [
            { name: 'Coche', cost: calc.car.totalCost + calc.accommodationCost },
            { name: 'Avión', cost: calc.plane.totalCost + calc.accommodationCost },
            { name: 'Tren', cost: calc.train.totalCost + calc.accommodationCost },
            { name: 'Autobús', cost: calc.bus.totalCost + calc.accommodationCost }
        ];
        totalCosts.sort((a, b) => a.cost - b.cost);

        doc.setFontSize(12);
        doc.setTextColor(16, 185, 129);
        doc.text(`Opción más económica (con alojamiento): ${totalCosts[0].name} - €${totalCosts[0].cost.toFixed(2)}`, leftMargin, y);

        y += 12;
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text('Los precios de tren y autobús son estimaciones basadas en distancia. Consultar Renfe/ALSA para precios reales.', leftMargin, y);
        y += 4;
        doc.text('Emisiones CO2 basadas en factores de la Agencia Europea de Medio Ambiente (EEA).', leftMargin, y);
        y += 4;
        doc.text(`Generado por Trip Cost & Efficiency Analytics - ${new Date().toLocaleString('es-ES')}`, leftMargin, y);

        // Save
        const filename = `Presupuesto_Viaje_${userName.replace(/\s+/g, '_')}.pdf`;
        doc.save(filename);

        showNotification(`PDF "${filename}" descargado correctamente.`, 'success');
    } catch (error) {
        console.error('Error generating PDF:', error);
        showNotification('Error al generar el PDF. Intenta de nuevo.', 'error');
    }
}

// --- Notifications ---
function showNotification(message, type) {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = 'notification';

    if (type === 'error') {
        notification.classList.add('error');
    } else if (type === 'info') {
        notification.classList.add('info');
    }

    notification.style.display = 'block';

    setTimeout(() => {
        notification.style.display = 'none';
    }, 4000);
}
