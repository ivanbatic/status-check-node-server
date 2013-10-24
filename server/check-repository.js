/**
 * Not using prototypes because this should be instantiated only once, 
 * so no performance gain there...
 */
function CheckRepository() {
    var self = this;
    var db = require('mongojs').connect('localhost:27017/status_checks', ['check_requests']);

    this.updateStatus = function(id, status) {
        var where = {_id: id};
        if (id instanceof Array) where._id = {$in: id};
        db.check_requests.update(where, {$set: {status: status}}, {upsert: false, multi: true});
    };

    this.overwriteCheck = function(check) {
        db.check_requests.update({_id: check._id}, check);
    }

    this.degradeUnfinishedRequests = function(client) {
        db.check_requests.update({
            request_client: client,
            status: 'queued'
        }, {
            $set: {
                status: 'pending'
            }
        }, {upsert: false, multi: true});
    };
    
    this.resetAllUnfinished = function(){
        db.check_requests.update({
            status: {
                $nin: ['success', 'failed']
            }
        }, {
            $set: {
                status: 'pending'
            }
        }, {upsert: false, multi: true});
    }

    this.getByStatus = function(status, clients, callback) {
        if (typeof (clients) === 'function') callback = clients;
        var where = {status: status};
        if (clients instanceof Array) where.request_client = {'$in': clients};
        db.check_requests.find(where, callback);
    }

    this.getClientRequests = function(client, callback) {
        db.check_requests.find({request_client: client}, callback);
    }
}

module.exports = CheckRepository;