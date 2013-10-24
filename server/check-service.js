function CheckService() {
    var self = this;
    // Dependencies
    var http = require('follow-redirects').http;
    var https = require('follow-redirects').https;
    var dns = require('dns');
    var url = require('url');
    var CheckRepository = require('./check-repository.js');

    // Create a check repository (mongo wrapper)
    var checkRepository = new CheckRepository();

    // Queuing and settings
    var queue = [];
    var checking = [];
    var checkingLimit = 20;
    var ipLimit = 3;
    var connectionTimeout = 5000;

    // Service loop
    var serviceIntervalTime = 100;
    var serviceInterval = null;

    var pullInterval = null;
    var pullIntervalTime = 100;

    // Active clients
    var clients = [];
    var clientSockets = {};

    // Event callbacks
    var callbacks = {
        'check_complete': null
    };


    /**
     * Adds a host into the queue
     * @param object host
     */
    this.addToQueue = function(host) {
        dns.lookup(sanitizeUrl(host.request_url).host, function(error, address) {
            host.ip = address;
            queue.push(host);
        });
    };

    /**
     * Goes through the queue in order to find hosts
     * that are eligible for checking and pushes them to the checking list
     */
    function dumpQueueToChecking() {
        // Early break if nothing to check or check limit reached
        if (queue.length === 0 || checking.length >= checkingLimit) return;
        var freeSpots = checkingLimit - checking.length;

        // IP -> count lookup map
        var ipCounts = {};

        // Count ip addresses in the currently checking section
        for (var i = 0; i < checking.length; i++) {
            // Go to the next one if this one has no ip
            if (!checking[i].ip) continue;
            // If it has an ip assigned, check if there is already a record in the map
            // if it does, update it (increment)
            if (ipCounts[checking[i].ip]) ipCounts[checking[i].ip]++;
            // if not, create one
            else ipCounts[checking[i].ip] = 1;
        }

        // Checks that are allowed to go into the checking phase
        var allowed = [];
        // Pick checks from the queue
        for (var i = 0; i < queue.length; i++) {
            // Early break if no more spots
            if (!freeSpots) break;
            // Store the ip for easy access
            var ip = queue[i].ip;
            // Check if this ip has a record in the map
            var ipCountExists = !!ipCounts[ip];

            /* 
             * Check has to satisfy one of the following
             * - Doesn't have an ip
             * - It's ip doesn't exist in the map (meaning no existing checks with the same ip)
             * - It's record in a map is lower than ipLimit
             */
            if (!ip || !ipCountExists || (ip && ipCountExists && ipCounts[ip] < ipLimit)) {
                // Yay, we can check this one
                Array.prototype.push.apply(checking, queue.splice(i, 1));
                // Update the map
                if (ip) ipCounts[ip] ? ipCounts[ip]++ : (ipCounts[ip] = 1);
                // Remove a free spot
                freeSpots--;
            }
        }
    }

    /**
     * Initiates the checking process for checks that are not already in progress
     */
    function initiateChecks() {
        for (var i = 0; i < checking.length; i++) {
            // Proceed to the next one if this one is already under check
            if (checking[i].status === 'in_progress') continue;

            checking[i].status = 'in_progress';
            updateAndEmit(checking[i]);
            checkHost(checking[i], function(host, index) {
                removeFromCheckingById(host._id);
                host.status = 'success';
                updateAndEmit(host);
            }, function(host) {
                console.log("Caught an error, yay!", host);
                checkRepository.updateStatus(host._id, 'failed');
                removeFromCheckingById(host._id);
                host.status = 'failed';
                updateAndEmit(host);
            });
        }
    }

    function removeFromCheckingById(id) {
        for (var i = 0; i < checking.length; i++) {
            if (checking[i]._id == id) {
                checking.splice(i, 1);
                break;
            }
        }
    }

    /**
     * Updates the given host object and emits the data_update event
     * @param object host
     */
    function updateAndEmit(host) {
        checkRepository.overwriteCheck(host);
        try {
            clientSockets[host.request_client].emit('data_update', [host]);
        } catch (ex) {
            console.log("Caught an error", ex);
        }
    }

    /**
     * Creates a parsed url object out of a string url
     * @param string address
     * @returns object
     */
    function sanitizeUrl(address) {
        var parsed = url.parse(address);
        if (!parsed.protocol) {
            var addr = (parsed.port === 443 ? 'https://' : 'http://') + address;
            parsed = url.parse(addr);
        }
        return parsed;
    }

    /**
     * Initiates a get request to check a host
     * @param object host
     * @param function endCallback End Callback
     * @param function error Error callback
     */
    function checkHost(host, endCallback, error) {
        var options = sanitizeUrl(host.request_url);
        options.agent = false;
        options.method = 'GET';
        var protocol = options.protocol === 'https' ? https : http;

        var endCause = 'success';
        var headers;
        var req = protocol.get(options, function(response) {
            var headers = response.headers;
            var contentLength = response.headers['content-length'] || 0;
            if (response.headers['content-length'] === undefined) {
                response.on('data', function(chunk) {
                    contentLength += chunk.length;
                });
            }

            response.on('end', function() {
                console.log("Ended:", endCause);
                host.status_code = response.statusCode;
                host.content_length = contentLength;
                if (typeof endCallback === 'function') {
                    endCallback(host);
                }
            }
            );
        });
        req.on('error', function(e) {
            if (typeof error === 'function') {
                error(host);
            }
        });
        setTimeout(function() {
            if (!headers) {
                req.abort();
            }
        }, connectionTimeout);
    }

    /**
     * Registeres a callback to the particular service event
     * @deprecated Not used anymore
     * @param event event
     * @param function callback
     */
    this.registerCallback = function(event, callback) {
        if (Object.keys(callbacks).indexOf(event) !== -1) {
            callbacks[event] = callback;
        }
    }

    /**
     *  Main service check loop
     */
    this.run = function() {
        // Pull scheduled checks from the database
        pullInterval = setInterval(function() {
            checkRepository.getByStatus('pending', clients, function(error, results) {
                var queuedIds = [];
                for (var i = 0; i < results.length; i++) {
                    self.addToQueue(results[i]);
                    queuedIds.push(results[i]._id);
                }
                checkRepository.updateStatus(queuedIds, 'queued');
            });
        }, pullIntervalTime);

        // Send from queue to checking...
        serviceInterval = setInterval(function() {
            dumpQueueToChecking();
            initiateChecks();
        }, serviceIntervalTime);
    };

    /**
     * Adds a connected client to the service's register
     * @param string client Client's IP address
     * @param socket socket
     * @returns CheckService self
     */
    this.addClient = function(client, socket) {
        clients.push(client);
        clientSockets[client] = socket;
        return self;
    };

    /**
     * Removes a client from a service
     * @param string client Client's IP address
     * @returns CheckService self
     */
    this.removeClient = function(client) {
        var index = clients.indexOf(client);
        checkRepository.degradeUnfinishedRequests(client);
        if (index >= 0) {
            clients.splice(index, 1);
        }

        delete clientSockets[client];
        return self;
    };
}

module.exports = CheckService;