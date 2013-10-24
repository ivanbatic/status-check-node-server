'use strict';

// Dependencies
var express = require('express');
var app = express();
var io = require('socket.io').listen(app.listen(5150), {log: false});

var CheckService = require('./check-service.js');
var CheckRepository = require('./check-repository.js');

// Create a check repository (mongo wrapper)
var checkRepository = new CheckRepository();

// Create a service instance
var checkService = new CheckService();

// Only clients starting with these addresses will be accepted
var allowedClients = ['127.0.', '10.0.', '192.168.'];

checkRepository.resetAllUnfinished();
checkService.run();
// Socket.IO connection event
io.sockets.on('connection', function(socket) {
    // Drop if not a local connection
    var client = socket.handshake.address.address;
    if (!isAllowedClient(client)) {
        console.log('Connection refused: ' + client);
        socket.disconnect();
        return;
    }
    console.log('Connection accepted: ' + client);
    // Get all 
    checkService.addClient(client, socket);
    checkRepository.getClientRequests(client, function(error, results) {
        // Emit all existing
        socket.emit('data_update', results);
    });

    socket.on('disconnect', function(socket) {
        console.log("Disconnected ", client);
        checkService.removeClient(client);
    });

    socket.emit('message', {
        message: 'Welcome to the Universe!'
    });
});

/**
 * Checks if client ip address is allowed 
 * to connect to the service
 * @param client string Ip address
 * @returns boolean 
 */
function isAllowedClient(client) {
    var clientIsLocal = false;
    for (var i = 0; i < allowedClients.length; i++) {
        if (client.indexOf(allowedClients[i]) === 0) {
            clientIsLocal = true;
            break;
        }
    }
    return clientIsLocal;
}