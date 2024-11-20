# SIGNALK-MQTT-SENSORS

Signal K Node Server Plugin that enables data from an MQTT host to be published to Signal K 
under a configurable set of paths.

Currently supports sensors of type:

- Pressure
- Temperature
- Humidity
- Battery Percentage
- Water Leak

The plugin can be easily configured through the Signal K UI to map between data published to
an MQTT topic and the paths for that data in Signal K.

1. Install the plugin from the Appstore.
2. Select Server -> Plugin Config and scroll to find "MQTT Sensors" in the list
3. Enter the URL for your MQTT server (mqtt://hostname or mqtts://hostname), and optionally a username and password to authenticate to the host.
4. Define your sensors. For each MQTT topic (e.g. `zigbee2mqtt/BilgeSensor`) you can define a set of Signal K paths to update when the topic changes.
    1. For each sensor, define the following properties:
        - Signal K Destination: The Signal K path that will be updated for this sensor (e.g. `environment.inside.cabin.temperature`)
        - Sensor Type: The type of sensor (temperature, humidity, pressure, etc.)
        - Unit: The source unit for the data being provided by the MQTT feed. The plugin will convert the data to the SI unit used by Signal K for this data type automatically.
        - JSON Path: A Json Path string to indicate where the value for this sensor is contained, if the payload is JSON. For example, `$.temperature` would return the value of the "temperature" property of the JSON object. This property is optional, the full payload will be used if not provided.
5. Check the box to enable the connection to the server and submit your changes.

