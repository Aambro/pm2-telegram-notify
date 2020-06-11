'use strict';

var pm2 = require('pm2');
var pmx = require('pmx');
var request = require('request');
var moment = require('moment');


// Get the configuration from PM2
var conf = pmx.initModule();

// initialize buffer and queue_max opts
// buffer seconds can be between 1 and 5
conf.buffer_seconds = (conf.buffer_seconds > 0 && conf.buffer_seconds < 5) ? conf.buffer_seconds : 1;

// queue max can be between 10 and 100
conf.queue_max = (conf.queue_max > 10 && conf.queue_max <= 100) ? conf.queue_max : 100;

// create the message queue
var messages = [];

// create the suppressed object for sending suppression messages
var suppressed = {
  isSuppressed: false,
  date: new Date().getTime()
};


// Function to send event to Telegram
function sendTelegram(message) {

    var name = message.name;
    var event = message.event;
    var description = message.description;
    var timestamp = message.timestamp;
    var dateNow = moment();


    // If a Telegram URL is not set, we do not want to continue and nofify the user that it needs to be set. URL must be formatted as ' https://api.telegram.org/bot<TOKEN>/sendMessage'
    if (!conf.telegram_url) return console.error("There is no telegram URL set, please set the telegram URL: 'pm2 set pm2-telegram-notify:telegram_url https://telegram_url'");
    console.log(dateNow.format("YYYY-MM-DD HH:mm:sss Z:") + ' ' + "Events in queue: " + messages.length)
    
    
    
    if (!conf.log_err) {
          var name = message.name; 
          var event = message.event;
          var description = message.description;
          var text  = (name + ' - ' +  event + ' - ' + description);
     

     var options = {
          method: 'post',
          headers: {'content-type' : 'application/x-www-form-urlencoded'},
          body: "chat_id="+conf.chat_id+"&text="+text,
          json: true,
          url: conf.telegram_url
     };


     // Finally, make the post request to the Telegram
     request(options, function(err, res, body) {
         if (err) return console.error(err);
         console.log(body)
     });

    }  else  if (conf.log_err /*&& !(conf.log || conf.error || conf.kill || conf.exception)*/) {

    // checks for event name and timestamps
    if ((messages.length != 0) && (event === 'log' && messages[0].event === 'error')  && (timestamp <= messages[0].timestamp)) {

    //Check for description's content
    if (messages[0].description.length > 30) {

    //Text for sending to telegram, must be <string>
     var length1 = 1000;
     var length2 = 3000;
     var cutDesc = description.substring(0, length1);
     var cutPrevDesc = messages[0].description.substring(0, length2);
     var text  = (name + ' - ' +  messages[0].event + ' - ' + cutDesc + '\n\n ' +  cutPrevDesc);


      // Options for the post request
     var options = {
          method: 'post',
          headers: {'content-type' : 'application/x-www-form-urlencoded'},
          body: "chat_id="+conf.chat_id+"&text="+text,
          json: true,
          url: conf.telegram_url
     };


     // Finally, make the post request to the Telegram
     request(options, function(err, res, body) {
         if (err) return console.error(err);
         console.log(body)
     });
    }
  }
}

}



// Function to get the next buffer of messages (buffer length = 1s)
function bufferMessage() {
  var nextMessage = messages.shift();

  if (!conf.buffer) { return nextMessage; }

  nextMessage.buffer = [nextMessage.description];

  // continue shifting elements off the queue while they are the same event and 
  // timestamp so they can be buffered together into a single request
  while (messages.length && 
    (messages[0].timestamp >= nextMessage.timestamp && 
      messages[0].timestamp < (nextMessage.timestamp + conf.buffer_seconds)) && 
    messages[0].event === nextMessage.event) {

    // append description to our buffer and shift the message off the queue and discard it
    nextMessage.buffer.push(messages[0].description);
    messages.shift();
  }

  // join the buffer with newlines
  nextMessage.description = nextMessage.buffer.join("\n");

  // delete the buffer from memory
  delete nextMessage.buffer;

  return nextMessage;
}

// Function to process the message queue
function processQueue() {

  // If we have a message in the message queue, removed it from the queue and send it to discord
  if (messages.length > 0) {
    sendToDiscord(bufferMessage());
  }

  // If there are over conf.queue_max messages in the queue, send the suppression message if it has not been sent and delete all the messages in the queue after this amount (default: 100)
  if (messages.length > conf.queue_max) {
    if (!suppressed.isSuppressed) {
      suppressed.isSuppressed = true;
      suppressed.date = new Date().getTime();
      sendToDiscord({
          name: 'pm2-discord',
          event: 'suppressed',
          description: 'Messages are being suppressed due to rate limiting.'
      });
    }
    messages.splice(conf.queue_max, messages.length);
  }

  // If the suppression message has been sent over 1 minute ago, we need to reset it back to false
  if (suppressed.isSuppressed && suppressed.date < (new Date().getTime() - 60000)) {
    suppressed.isSuppressed = false;
  }

  // Wait 10 seconds and then process the next message in the queue
  setTimeout(function() {
    processQueue();
  }, 10000);
}


function createMessage(data, eventName, altDescription) {
  // we don't want to output pm2-telegram-notify's logs
  if (data.process.name === 'pm2-telegram-notify') {
    return;
  }
  // if a specific process name was specified then we check to make sure only 
  // that process gets output
  if (conf.process_name !== null && data.process.name !== conf.process_name) {
    return;
  }

  var msg = altDescription || data.data;
  if (typeof msg === "object") {
    msg = JSON.stringify(msg);
  } 

  messages.push({
    name: data.process.name,
    event: eventName,
    description: stripAnsi(msg),
    timestamp: Math.floor(Date.now() / 1000),
  });
}


// Start listening on the PM2 BUS
pm2.launchBus(function(err, bus) {

    // Listen for process logs
    if (conf.log) {
      bus.on('log:out', function(data) {
        createMessage(data, 'log');
      });
    }

    // Listen for process errors
    if (conf.error) {
      bus.on('log:err', function(data) {
        createMessage(data, 'error');
      });
    }

    // Listen for PM2 kill
    if (conf.kill) {
      bus.on('pm2:kill', function(data) {
        messages.push({
          name: 'PM2',
          event: 'kill',
          description: data.msg,
          timestamp: Math.floor(Date.now() / 1000),
        });
      });
    }

    // Listen for process exceptions
    if (conf.exception) {
      bus.on('process:exception', function(data) {
        createMessage(data, 'exception');
      });
    }

    // Listen for PM2 events
    bus.on('process:event', function(data) {
      if (!conf[data.event]) { return; }
      var msg = 'The following event has occured on the PM2 process ' + data.process.name + ': ' + data.event;
      createMessage(data, data.event, msg);
    });

    // Start the message processing
    processQueue();

});
