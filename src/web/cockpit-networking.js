/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2013 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

var cockpit = cockpit || { };

(function($, cockpit, cockpit_pages) {

function nm_debug() {
    if (cockpit.debugging == "all" || cockpit.debugging == "nm")
        console.debug.apply(console, arguments);
}

function NetworkManagerModel(address) {
    var self = this;

    var client = cockpit.dbus(address,
                              { 'bus':          "system",
                                'service':      "org.freedesktop.NetworkManager",
                                'object-paths': [ "/org/freedesktop/NetworkManager" ]
                              });

    var objects = { };

    self.devices = [ ];

    function call_settings_update (obj, path) {
        var dfd = new $.Deferred();
        if (!obj[' mods']) {
            dfd.resolve(false);
        } else {
            var nm_settings = settings_to_nm(obj[' orig'], obj.Settings, obj[' mods']);
            var iface = client.get(path, 'org.freedesktop.NetworkManager.Settings.Connection');
            iface.call('Update', nm_settings,
                       function (error) {
                           if (error) {
                               cockpit_show_unexpected_error(error);
                               dfd.reject(error);
                           } else {
                               obj[' mods'] = null;
                               dfd.resolve(true);
                           }
                       });
        }
        return dfd.promise();
    }

    function start_settings_modification (obj, first, second) {
        if (!obj[' mods'])
            obj[' mods'] = { };
        if (!obj[' mods'][first])
            obj[' mods'][first] = { };
        obj[' mods'][first][second] = true;
    }

    function get_object(path) {
        if (path == "/")
            return null;
        if (!objects[path]) {
            objects[path] = {
                ' path': path,
                call: function (iface, method) {
                    var dfd = new $.Deferred();
                    var proxy = client.get(path, iface);
                    proxy.call(method, function (error) {
                        if (error)
                            dfd.reject(error);
                        else
                            dfd.resolve();
                    });
                    return dfd.promise();
                },
                // XXX - put this only on settings
                update: function (settings) {
                    return call_settings_update (this, path, settings);
                },
                freeze: function (first, second) {
                    return start_settings_modification (this, first, second);
                }
            };
        }
        return objects[path];
    }

    function toDec(n) {
        return n.toString(10);
    }

    function bytes_from_nm32(num) {
        var bytes = [], i;
        if (client.byteorder == "be") {
            for (i = 3; i >= 0; i--) {
                bytes[i] = num & 0xFF;
                num = num >>> 8;
            }
        } else {
            for (i = 0; i < 4; i++) {
                bytes[i] = num & 0xFF;
                num = num >>> 8;
            }
        }
        return bytes;
    }

    function bytes_to_nm32(bytes) {
        var num = 0, i;
        if (client.byteorder == "be") {
            for (i = 0; i < 4; i++) {
                num = 256*num + bytes[i];
            }
        } else {
            for (i = 3; i >= 0; i--) {
                num = 256*num + bytes[i];
            }
        }
        return num;
    }

    function ip4_to_text(num) {
        return bytes_from_nm32(num).map(toDec).join('.');
    }

    function ip4_from_text(text) {
        var parts = text.split('.');
        if (parts.length == 4)
            return bytes_to_nm32(parts.map(function(s) { return parseInt(s, 10); }));
        else // XXX - error
            return 0;
    }

    function ip4_from_nm(addr) {
        return [ ip4_to_text(addr[0]),
                 addr[1],
                 ip4_to_text(addr[2])
               ];
    }

    function ip4_to_nm(addr) {
        return [ ip4_from_text(addr[0]),
                 parseInt(addr[1], 10) || 24,
                 ip4_from_text(addr[2])
               ];
    }

    function ip6_from_text(text) {
        var parts = text.split(':');
        var bytes = [];
        for (var i = 0; i < 8; i++) {
            var num = parseInt(parts[i], 16) || 0;
            bytes[2*i] = num >> 8;
            bytes[2*i+1] = num & 255;
        }
        return bytes;
    }

    function ip6_to_text(bytes) {
        var parts = [];
        for (var i = 0; i < 8; i++)
            parts[i] = ((bytes[2*i] << 8) + bytes[2*i+1]).toString(16);
        return parts.join(':');
    }

    function ip6_from_nm(addr) {
        return [ ip6_to_text(addr[0]),
                 addr[1],
                 ip6_to_text(addr[2])
               ];
    }

    function ip6_to_nm(addr) {
        return [ ip6_from_text(addr[0]),
                 parseInt(addr[1], 10) || 64,
                 ip6_from_text(addr[2])
               ];
    }


    function settings_from_nm(settings, old, mods) {
        var result = { };

        function from_nm(first, second, def, trans) {
            if (!result[first])
                result[first] = { };
            if (!trans)
                trans = function (x) { return x; };
            if ((!mods || !mods[first] || !mods[first][second]) && settings[first] && settings[first][second])
                result[first][second] = trans(settings[first][second].val);
            else
                result[first][second] = def;
        }

        from_nm("connection", "id", _("Unknown"));
        from_nm("connection", "autoconnect", true);
        from_nm("ipv4", "method", "auto");
        from_nm("ipv4", "addresses", [], function (addrs) { return addrs.map(ip4_from_nm); });
        from_nm("ipv4", "dns", [], function (addrs) { return addrs.map(ip4_to_text); });
        from_nm("ipv6", "method", "auto");
        from_nm("ipv6", "addresses", [], function (addrs) { return addrs.map(ip6_from_nm); });
        from_nm("ipv6", "dns", [], function (addrs) { return addrs.map(ip6_to_text); });
        return result;
    }

    function settings_to_nm(orig, settings, mods) {
        var result = $.extend(true, {}, orig);

        function to_nm(first, second, sig, trans) {
            if (!trans)
                trans = function (x) { return x; };
            if (mods && mods[first] && mods[first][second])
                result[first][second] = new DBusVariant(sig, trans(settings[first][second]));
        }

        to_nm("connection", "id", 's');
        to_nm("connection", "autoconnect", 'b');
        to_nm("ipv4", "method", 's');
        to_nm("ipv4", "addresses", 'aau', function (addrs) { return addrs.map(ip4_to_nm); });
        to_nm("ipv4", "dns", 'au', function (addrs) { return addrs.map(ip4_from_text); });
        to_nm("ipv6", "method", 's');
        to_nm("ipv6", "addresses", 'a(ayuay)', function (addrs) { return addrs.map(ip6_to_nm); });
        to_nm("ipv6", "dns", 'aay', function (addrs) { return addrs.map(ip6_from_text); });
        return result;
    }

    function device_state_to_text(state) {
        switch (state) {
            // NM_DEVICE_STATE_UNKNOWN
        case 0: return "?";
            // NM_DEVICE_STATE_UNMANAGED
            case 10: return "";
            // NM_DEVICE_STATE_UNAVAILABLE
        case 20: return _("Not available");
            // NM_DEVICE_STATE_DISCONNECTED
        case 30: return _("Disconnected");
            // NM_DEVICE_STATE_PREPARE
        case 40: return _("Preparing");
            // NM_DEVICE_STATE_CONFIG
        case 50: return _("Configuring");
            // NM_DEVICE_STATE_NEED_AUTH
        case 60: return _("Authenticating");
            // NM_DEVICE_STATE_IP_CONFIG
        case 70: return _("Configuring IP");
            // NM_DEVICE_STATE_IP_CHECK
        case 80: return _("Checking IP");
            // NM_DEVICE_STATE_SECONDARIES
        case 90: return _("Waiting");
            // NM_DEVICE_STATE_ACTIVATED
        case 100: return _("Active");
            // NM_DEVICE_STATE_DEACTIVATING
        case 110: return _("Deactivating");
            // NM_DEVICE_STATE_FAILED
        case 120: return _("Failed");
        default: return "";
        }
    }

    function model_properties_changed (path, iface, props) {
        /* HACK
         *
         * NetworkManager interfaces have their own PropertiesChanged signals,
         * so we catch them here and tell the interfaces to update their
         * values.
         *
         * Unfortunatly, o.f.NM.Device doesn't have a PropertiesChanged
         * signal.  Instead, the specialized interfaces like
         * o.f.NM.Device.Wired do double duty: Their PropertiesChanged signals
         * contain change notifications for both themselves and the
         * o.f.NM.Device properties.
         *
         * We 'solve' this here by merging the properties of all interfaces
         * for a given object.
         *
         * https://bugzilla.gnome.org/show_bug.cgi?id=729826
         */

        var obj = get_object(path);
        if (iface == "org.freedesktop.NetworkManager") {
            if (props.Devices)    obj.Devices = props.Devices.map(get_object);
            if (props.ActiveConnections)    obj.ActiveConnections = props.ActiveConnections.map(get_object);
        } else if (iface == "org.freedesktop.NetworkManager.Device" ||
                   iface.startsWith("org.freedesktop.NetworkManager.Device.")) {
            if (props.DeviceType) obj.DeviceType = props.DeviceType;
            if (props.Interface)  obj.Interface = props.Interface;
            if (props.Ip4Config)  obj.Ip4Config = get_object(props.Ip4Config);
            if (props.Ip6Config)  obj.Ip6Config = get_object(props.Ip6Config);
            if (props.State)      obj.State = device_state_to_text(props.State);
            if (props.HwAddress)  obj.HwAddress = props.HwAddress;
            if (props.AvailableConnections)  obj.AvailableConnections = props.AvailableConnections.map(get_object);
            if (props.ActiveConnection)  obj.ActiveConnection = get_object(props.ActiveConnection);
            if (props.Udi)        refresh_udev (path, props.Udi);
            if (props.IdVendor)   obj.IdVendor = props.IdVendor;
            if (props.IdModel)    obj.IdModel = props.IdModel;
            if (props.Driver)     obj.Driver = props.Driver;
        } else if (iface == "org.freedesktop.NetworkManager.IP4Config") {
            if (props.Addresses)  obj.Addresses = props.Addresses.map(ip4_from_nm);
        } else if (iface == "org.freedesktop.NetworkManager.IP6Config") {
            if (props.Addresses)  obj.Addresses = props.Addresses.map(ip6_from_nm);
        } else if (iface == "org.freedesktop.NetworkManager.Settings.Connection") {
            if (props.Unsaved)    obj.Unsaved = props.Unsaved;
        } else if (iface == "org.freedesktop.NetworkManager.Connection.Active") {
            if (props.Connection) obj.Connection = get_object(props.Connection);
        }
        export_model();
    }

    function model_removed (path) {
        delete objects[path];
    }

    function model_refresh (path, iface) {
        var p = client.get(path, "org.freedesktop.DBus.Properties");
        p.call('GetAll', iface,
               function (error, result) {
                   if (!error) {
                       model_properties_changed(path, iface, remove_signatures(result));
                       if (iface == "org.freedesktop.NetworkManager.Settings.Connection") {
                           var proxy = client.get(path, iface);
                           refresh_settings(proxy);
                       }
                   }
               });
    }

    var changed_pending;

    function export_model() {
        var manager = objects["/org/freedesktop/NetworkManager"];
        self.devices = (manager && manager.Devices) || [];

        if (!changed_pending) {
            changed_pending = true;
            setTimeout(function () { changed_pending = false; $(self).trigger('changed'); }, 0);
        }
    }

    function remove_signatures(props_with_sigs) {
        var props = { };
        for (var p in props_with_sigs) {
            if (props_with_sigs.hasOwnProperty(p)) {
                props[p] = props_with_sigs[p].val;
            }
        }
        return props;
    }

    function refresh_all_devices() {
        for (var path in objects) {
            if (path.startsWith("/org/freedesktop/NetworkManager/Devices/"))
                model_refresh(path, "org.freedesktop.DBus.Properties");
        }
    }

    function refresh_settings(iface) {
        iface.call('GetSettings', function (error, result) {
            if (result) {
                var path = iface.getObject().objectPath;
                var obj = get_object(path);
                obj[' orig'] = result;
                obj.Settings = settings_from_nm(result, obj.Settings, obj[' mods']);
                export_model ();
            }
        });
    }

    function refresh_udev(path, sysfs_path) {
        cockpit.spawn(["/usr/bin/udevadm", "info", sysfs_path], { host: address }).
            done(function(res) {
                var props = { };
                function snarf_prop(line, env, prop) {
                    var prefix = "E: " + env + "=";
                    if (line.startsWith(prefix)) {
                        props[prop] = line.substr(prefix.length);
                    }
                }
                res.split('\n').forEach(function(line) {
                    snarf_prop(line, "ID_MODEL_FROM_DATABASE", "IdModel");
                    snarf_prop(line, "ID_VENDOR_FROM_DATABASE", "IdVendor");
                });
                model_properties_changed(path, "org.freedesktop.NetworkManager.Device", props);
            }).
            fail(function(ex) {
                console.warn(ex);
            });
    }

    function object_added (event, object) {
        for (var iface in object._ifaces)
            interface_added (event, object, object._ifaces[iface]);
    }

    function object_removed (event, object) {
        for (var iface in object._ifaces)
            interface_removed (event, object, object._ifaces[iface]);
    }

    function interface_added (event, object, iface) {
        var path = object.objectPath;
        model_properties_changed (path, iface._iface_name, iface);
        if (iface._iface_name == "org.freedesktop.NetworkManager.Settings.Connection")
            refresh_settings(iface);
    }

    function interface_removed (event, object, iface) {
        var path = object.objectPath;
        model_removed (path);
    }

    function signal_emitted (event, iface, signal, args) {
        if (signal == "PropertiesChanged") {
            var path = iface.getObject().objectPath;
            model_properties_changed (path, iface._iface_name, remove_signatures(args[0]));
        } else if (signal == "Updated") {
            refresh_settings(iface);

            /* HACK
             *
             * Some versions of NetworkManager don't always send
             * PropertyChanged notifications for the
             * o.f.NM.Device.Ip4Config property.
             *
             * https://bugzilla.gnome.org/show_bug.cgi?id=729828
             */
            refresh_all_devices();
        }
    }

    $(client).on("objectAdded", object_added);
    $(client).on("objectRemoved", object_removed);
    $(client).on("interfaceAdded", interface_added);
    $(client).on("interfaceRemoved", interface_removed);
    $(client).on("signalEmitted", signal_emitted);

    self.destroy = function destroy() {
        $(client).off("objectAdded", object_added);
        $(client).off("objectRemoved", object_removed);
        $(client).off("interfaceAdded", interface_added);
        $(client).off("interfaceRemoved", interface_removed);
        $(client).off("signalEmitted", signal_emitted);
        client.release();
    };

    self.find_device = function find_device(iface) {
        for (var i = 0; i < self.devices.length; i++) {
            if (self.devices[i].Interface == iface)
                return self.devices[i];
        }
        return null;
    };

    function objpath(obj) {
        if (obj && obj[' path'])
            return obj[' path'];
        else
            return "/";
    }

    self.activate_connection = function activate_connection(connection, dev, specific_object) {
        var manager = client.get("/org/freedesktop/NetworkManager", "org.freedesktop.NetworkManager");
        manager.call('ActivateConnection', objpath(connection), objpath(dev), objpath(specific_object),
                     function (error, result) {
                         if (error)
                             cockpit_show_unexpected_error(error);
                     });
    };

    self.deactivate_connection = function deactivate_connection(active_connection) {
        var manager = client.get("/org/freedesktop/NetworkManager", "org.freedesktop.NetworkManager");
        manager.call('DeactivateConnection', objpath(active_connection),
                     function (error, result) {
                         if (error)
                             cockpit_show_unexpected_error(error);
                     });
    };

    client.getObjectsFrom("/").forEach(function (object) {
        for (var iface in object._ifaces)
            model_refresh (object.objectPath, iface);
    });

    return self;
}

var nm_models = { };

function get_nm_model(machine) {
    if (!machine)
        machine = cockpit_get_page_param ("machine", "server");

    var handle = nm_models[machine];

    if (!handle) {
        nm_debug("Creating NM model for %s", machine);
        handle = { refcount: 1, model: new NetworkManagerModel(machine) };
        nm_models[machine] = handle;

        handle.model.release = function() {
            nm_debug("Releasing %s", machine);
            // Only really release it after a delay
            setTimeout(function () {
                if (!handle.refcount) {
                    console.warn("Releasing unreffed client");
                } else {
                    handle.refcount -= 1;
                    if (handle.refcount === 0) {
                        delete nm_models[machine];
                        nm_debug("Destroying %s", machine);
                        handle.model.destroy();
                    }
                }
            }, 10000);
        };
    } else {
        nm_debug("Getting NM model for %s", machine);
        handle.refcount += 1;
    }

    return handle.model;
}

PageNetworking.prototype = {
    _init: function () {
        this.id = "networking";
    },

    getTitle: function() {
        return C_("page-title", "Networking");
    },

    enter: function () {
        this.model = get_nm_model();
        $(this.model).on('changed.network-interface', $.proxy(this, "update_devices"));
        this.update_devices();
    },

    show: function() {
    },

    leave: function() {
        $(this.model).off(".network-interface");
        this.model.release();
        this.model = null;
    },

    update_devices: function() {
        var self = this;
        var tbody;

        tbody = $('#networking-interfaces tbody');
        tbody.empty();
        self.model.devices.forEach(function (dev) {
            if (!dev)
                return;

            // Skip loopback
            if (dev.DeviceType == 14)
                return;

            var addresses = [ ];

            var ip4config = dev.Ip4Config;
            if (ip4config && ip4config.Addresses) {
                ip4config.Addresses.forEach(function (a) {
                    addresses.push(a[0] + "/" + a[1]);
                });
            }

            var ip6config = dev.Ip6Config;
            if (ip6config && ip6config.Addresses) {
                ip6config.Addresses.forEach(function (a) {
                    addresses.push(a[0] + "/" + a[1]);
                });
            }

            tbody.append($('<tr>').
                         append($('<td>').text(dev.Interface),
                                $('<td>').text(addresses.join(", ")),
                                $('<td>').text(dev.HwAddress),
                                $('<td>').text(dev.State)).
                         click(function () { cockpit_go_down ({ page: 'network-interface',
                                                                dev: dev.Interface
                                                              });
                                           }));
        });
    }

};

function PageNetworking() {
    this._init();
}

cockpit_pages.push(new PageNetworking());

PageNetworkInterface.prototype = {
    _init: function () {
        this.id = "network-interface";
        this.connection_mods = { };
    },

    getTitle: function() {
        return C_("page-title", "Network Interface");
    },

    setup: function () {
        $('#network-interface-disconnect').click($.proxy(this, "disconnect"));
    },

    enter: function () {
        var self = this;

        self.model = get_nm_model();
        $(self.model).on('changed.network-interface', $.proxy(self, "update"));

        self.dev = null;
        self.update();
    },

    show: function() {
    },

    leave: function() {
        $(this.model).off(".network-interface");
        this.model.release();
        this.model = null;
        this.dev = null;
    },

    disconnect: function() {
        if (this.dev)
            this.dev.
            call('org.freedesktop.NetworkManager.Device', 'Disconnect').
            fail(cockpit_show_unexpected_error);
    },

    update: function() {
        var self = this;

        var $hw = $('#network-interface-hw');
        var $connections = $('#network-interface-connections');

        $hw.empty();
        $connections.empty();

        var dev = self.model.find_device(cockpit_get_page_param('dev'));
        if (!dev)
            return;

        self.dev = dev;

        var addresses = [ ];

        var ip4config = dev.Ip4Config;
        if (ip4config && ip4config.Addresses) {
            ip4config.Addresses.forEach(function (a) {
                addresses.push(a[0] + "/" + a[1]);
            });
        }

        var ip6config = dev.Ip6Config;
        if (ip6config && ip6config.Addresses) {
            ip6config.Addresses.forEach(function (a) {
                addresses.push(a[0] + "/" + a[1]);
            });
        }

        $hw.append($('<table class="table">').
                   append($('<tr>').
                          append($('<td>').text(dev.Driver),
                                 $('<td>').text(dev.IdVendor),
                                 $('<td>').text(dev.IdModel),
                                 $('<td>').text(dev.HwAddress)),
                          $('<tr>').
                          append($('<td>').text(dev.Interface),
                                 $('<td colspan="2">').text(addresses.join(", ")),
                                 $('<td>').text(dev.State))));

        function render_connection(con) {

            if (!con || !con.Settings)
                return [ ];

            var is_active = dev.ActiveConnection && dev.ActiveConnection.Connection === con;

            var settings_box, mod_box;

            function start_modify_setting(first, second) {
                con.freeze(first, second);
            }

            function finish_modify_setting() {
                $(settings_box).text(JSON.stringify(con.Settings));
                $(mod_box).text(JSON.stringify(con[' mods']));
            }

            function modify_setting(first, second, val) {
                start_modify_setting(first, second);
                con.Settings[first][second] = val;
                finish_modify_setting();
            }

            function apply_settings() {
                con.update().
                    done(function (something_changed) {
                        if (is_active && something_changed)
                            activate_connection();
                    });
            }

            function checkbox(first, second) {
                return ($('<input type="checkbox">').
                        prop('checked', con.Settings[first][second]).
                        change(function (event) {
                            modify_setting(first, second, $(event.target).prop('checked'));
                        }));
            }

            function textbox(first, second) {
                return ($('<input>').
                        val(con.Settings[first][second]).
                        change(function (event) {
                            modify_setting(first, second, $(event.target).val());
                        }));
            }

            function choicebox(first, second, choices) {
                var btn = cockpit_select_btn(function (choice) {
                                                 modify_setting(first, second, choice);
                                             },
                                             choices);
                cockpit_select_btn_select(btn, con.Settings[first][second]);
                return btn;
            }

            function addrbox(first, second) {
                function add() {
                    return function() {
                        modify_setting(first, second, con.Settings[first][second].concat([[ "", "", "" ]]));
                        self.update();
                    };
                }

                function remove(index) {
                    return function () {
                        start_modify_setting(first, second);
                        con.Settings[first][second].splice(index,1);
                        finish_modify_setting();
                        self.update();
                    };
                }

                function change(index) {
                    return function (event) {
                        var div = $(event.target).parent('div');
                        var addr = [ $(div).find("input:nth-child(1)").val(),
                                     $(div).find("input:nth-child(2)").val(),
                                     $(div).find("input:nth-child(3)").val()
                                   ];
                        start_modify_setting(first, second);
                        con.Settings[first][second][index] = addr;
                        finish_modify_setting();
                        self.update();
                    };
                }

                return ($('<div>').
                        append($('<button class="btn btn-default">').
                               text(_("Add")).
                               click(add()),
                               con.Settings[first][second].map(function (a, i) {
                                   return ($('<div>').
                                           append($('<input>').val(a[0]).change(change(i)),
                                                  $('<input>').val(a[1]).change(change(i)),
                                                  $('<input>').val(a[2]).change(change(i)),
                                                  $('<button>').
                                                  text(_("X")).
                                                  click(remove(i))));
                               })));
            }

            function textlistbox(first, second) {
                function add() {
                    return function() {
                        modify_setting(first, second, con.Settings[first][second].concat([""]));
                        self.update();
                    };
                }

                function remove(index) {
                    return function () {
                        start_modify_setting(first, second);
                        con.Settings[first][second].splice(index,1);
                        finish_modify_setting();
                        self.update();
                    };
                }

                function change(index) {
                    return function (event) {
                        var div = $(event.target).parent('div');
                        var text = $(div).find("input:nth-child(1)").val();
                        start_modify_setting(first, second);
                        con.Settings[first][second][index] = text;
                        finish_modify_setting();
                        self.update();
                    };
                }

                return ($('<div>').
                        append($('<button class="btn btn-default">').
                               text(_("Add")).
                               click(add()),
                               con.Settings[first][second].map(function (a, i) {
                                   return ($('<div>').
                                           append($('<input>').val(a).change(change(i)),
                                                  $('<button>').
                                                  text(_("X")).
                                                  click(remove(i))));
                               })));
            }

            function render_connection_settings() {
                return ($('<table class="cockpit-form-table">').
                        append($('<tr>').
                               append($('<td class="header">').text(_("Connection"))),
                               $('<tr>').
                               append($('<td>').text(_("Connect automatically")),
                                      $('<td>').append(checkbox("connection", "autoconnect")))));
            }

            function render_ipv4_settings() {
                var method_choices = [
                    { choice: 'auto',         title: _("Automatic (DHCP)") },
                    { choice : 'link-local',  title: _("Link local") },
                    { choice: 'manual',       title: _("Manual") },
                    { choice: 'shared',       title: _("Shared") },
                    { choice: 'disabled',     title: _("Disabled") }
                ];

                return ($('<table class="cockpit-form-table">').
                        append($('<tr>').
                               append($('<td class="header">').text(_("IPv4"))),
                               $('<tr>').
                               append($('<td>').text(_("Method")),
                                      $('<td>').append(choicebox("ipv4", "method", method_choices))),
                               $('<tr>').
                               append($('<td style="vertical-align:top">').text(_("Addresses")),
                                      $('<td>').append(addrbox("ipv4", "addresses"))),
                               $('<tr>').
                               append($('<td style="vertical-align:top">').text(_("DNS")),
                                      $('<td>').append(textlistbox("ipv4", "dns")))));
            }

            function render_ipv6_settings(ipv4) {
                var method_choices = [
                    { choice: 'auto',         title: _("Automatic") },
                    { choice: 'dhcp',         title: _("Automatic (DHCP only)") },
                    { choice : 'link-local',  title: _("Link local") },
                    { choice: 'manual',       title: _("Manual") },
                    { choice: 'ignore',       title: _("Ignore") }
                ];

                return ($('<table class="cockpit-form-table">').
                        append($('<tr>').
                               append($('<td class="header">').text(_("IPv6"))),
                               $('<tr>').
                               append($('<td>').text(_("Method")),
                                      $('<td>').append(choicebox("ipv6", "method", method_choices))),
                               $('<tr>').
                               append($('<td style="vertical-align:top">').text(_("Addresses")),
                                      $('<td>').append(addrbox("ipv6", "addresses"))),
                               $('<tr>').
                               append($('<td style="vertical-align:top">').text(_("DNS")),
                                      $('<td>').append(textlistbox("ipv6", "dns")))));
            }

            function activate_connection() {
                self.model.activate_connection(con, self.dev, null);
            }

            function deactivate_connection() {
                self.model.deactivate_connection(self.dev.ActiveConnection);
            }

            return ($('<div class="panel panel-default">').
                    append($('<div class="panel-heading">').
                           append($('<span>').text(con.Settings.connection.id),
                                  $('<span>').text(is_active? " (active)" : ""),
                                  $('<button class="btn btn-default" style="display:inline;float:right">').
                                  text(is_active? "Deactivate" : "Activate").
                                  click(is_active? deactivate_connection : activate_connection),
                                  $('<button class="btn btn-default" style="display:inline;float:right;margin-right:10px">').
                                  text("Apply").
                                  click(apply_settings)),
                           $('<div class="panel-body">').
                           append(render_connection_settings(con.Settings.connection),
                                  $('<hr>'),
                                  render_ipv4_settings(),
                                  $('<hr>'),
                                  render_ipv6_settings(),
                                  $('<hr>'),
                                  $('<div>').text(JSON.stringify(con[' orig'])),
                                  settings_box = $('<div>').text(JSON.stringify(con.Settings)),
                                  mod_box = $('<div>').text(JSON.stringify(con[' mods'])))));
        }

        (dev.AvailableConnections || []).forEach(function (con) {
            $connections.append(render_connection(con));
        });
    }

};

function PageNetworkInterface() {
    this._init();
}

cockpit_pages.push(new PageNetworkInterface());

})($, cockpit, cockpit_pages);
