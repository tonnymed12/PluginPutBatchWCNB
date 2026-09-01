sap.ui.define([
    'jquery.sap.global',
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/ui/model/json/JSONModel",
    "./Utils/Commons",
    "./Utils/ApiPaths",
    "../model/formatter",
    "sap/ui/core/Element",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
], function (jQuery, PluginViewController, JSONModel, Commons, ApiPaths, formatter, Element, MessageBox, Fragment) {
    "use strict";

    var gOperationPhase = {};
    const OPERATION_STATUS = { ACTIVE: "ACTIVE", QUEUED: "IN_QUEUE" }

    return PluginViewController.extend("serviacero.custom.plugins.zpluginPutBatchWCNB.zpluginPutBatchWCNB.controller.MainView", {
        Commons: Commons,
        ApiPaths: ApiPaths,
        formatter: formatter,

        onInit: function () {
            PluginViewController.prototype.onInit.apply(this, arguments);
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var planta = oPODParams.PLANT_ID;
            this.oScanInput = this.byId("scanInput");
            this._oScanDebounceTimer = null;
            this.iSecuenciaCounter = 0;  // Contador de secuencia para cada escaneo
            this.sAcActivity = "";       // Guardar valor AC_ACTIVITY del puesto
            this._aBomNormalComponents = [];  // Componentes NORMAL de la BOM para el popover de lotes
            this._oCachedPODParams = null; // Cache de params para sobrevivir navegación fuera del POD
            this.isMolinos = planta;  //guarda el puesto al iniciar 

            // Modelo "orderSummary" 
            const oOrderSummaryModel = new JSONModel({
                // lote: "",
                material: "",
                descripcion: "",
                cantidadNecesaria: 0,
                unidadMedida: "",
                cantidadEscaneada: 0
            });
            this.getView().setModel(oOrderSummaryModel, "orderSummary");

        },
        onAfterRendering: function () {
            this.onGetCustomValues();
            this.setOrderSummary();
            if (this.isMolinos == "1201" || this.isMolinos == "1202") {
                this.setBotonBatches();
            }
        },
        setBotonBatches: function () {
            const oView = this.getView();
            const oButton = oView.byId("lotesBoton");

            oButton.setVisible(false);
        },
        onGetCustomValues: function () {
            const oView = this.getView(),
                oSapApi = this.getPublicApiRestDataSourceUri(),
                oTable = oView.byId("idSlotTable");

            var oPODParams = this._getPODParamsWithCache();
            if (!oPODParams) {
                // Sin contexto y sin caché: no hay nada que cargar
                return;
            }

            const url = oSapApi + this.ApiPaths.OPERATION_ACTIVITIES,
                oParams = {
                    plant: oPODParams.PLANT_ID,
                    operation: oPODParams.OPERATION_ACTIVITY
                };

            this.ajaxGetRequest(url, oParams, function (oRes) {
                // content es un array paginado, tomamos el primer elemento
                var aContent = (oRes && oRes.content) || [];
                const oData = aContent[0];

                if (!oData || !oData.customValues) {
                    console.error("No se encontraron customValues en la respuesta");
                    return;
                }

                // Guardar para que setCustomValuesPp pueda construir el payload inData
                this._oOperationActivityData = oData;

                const aCustomValues = oData.customValues;

                const acActivity = aCustomValues.find((element) => element.attribute == "AC_ACTIVITY");

                // Guardar AC_ACTIVITY en la variable de instancia
                if (acActivity) {
                    this.sAcActivity = acActivity.value || "";
                } else {
                    this.sAcActivity = "";
                }
                // Lista dinámica: solo slots ocupados (sin pre-población por SLOTQTY)
                const aSlotsFixed = aCustomValues.filter(function (item) {
                    return item.attribute.startsWith("SLOT") &&
                        item.attribute !== "SLOTQTY" &&
                        item.attribute !== "SLOTTIPO" &&
                        item.value && item.value.trim() !== "";
                });

                aSlotsFixed.forEach(function (slot) {
                    slot.loteQty = slot.loteQty || "";
                    slot.loteUom = slot.loteUom || "";
                });

                // Setear los datos en la tabla
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aSlotsFixed }));
                this._updateOrderSummaryScannedQty(aSlotsFixed);

                // Setear contador en input
                const oSlotQtyInput = oView.byId("slotQty");
                if (oSlotQtyInput) {
                    oSlotQtyInput.setValue(aSlotsFixed.length.toString());
                }

                // Resetear o sincronizar secuencia
                const iSlotTotal = aSlotsFixed.filter(slot => slot.value && slot.value.trim() !== "").length;
                if (iSlotTotal === 0) {
                    this.iSecuenciaCounter = 0;
                } else {
                    // Si hay slots, obtener el máximo número de secuencia para continuar desde ahí
                    const maxSecuencia = Math.max(...aSlotsFixed
                        .filter(slot => slot.value)
                        .map(slot => {
                            const parts = (slot.value || "").split('!');
                            return parseInt(parts[parts.length - 1] || 0);
                        })
                    );
                    this.iSecuenciaCounter = maxSecuencia;
                }

            }.bind(this));
        },
        onBarcodeSubmit: function () {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            const sBarcode = oInput.getValue().trim();
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (!sBarcode) {
                return; // no hacer nada si está vacío
            }

            const oTable = oView.byId("idSlotTable");
            const oModel = oTable.getModel();
            const aItems = oModel.getProperty("/ITEMS") || [];

            const iSlotsConValor = aItems.filter(slot => slot.value && slot.value.trim() !== "").length;
            if (iSlotsConValor === 0) {
                this.iSecuenciaCounter = 0;
            }

            //comparacion del lote ingresado 
            const sNormalizado = sBarcode.toUpperCase();

            const partsBarcode = sNormalizado.split('!');

            if (partsBarcode.length < 2 || !partsBarcode[0] || !partsBarcode[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                oInput.setValue(""); oInput.focus();
                return;
            }
            const loteExtraido = partsBarcode[1].trim();
            const materialExtraido = partsBarcode[0].trim();

            // Early duplicate check: comparar material!lote contra las 2 primeras partes del valor guardado
            const sMaterialLoteEscaneado = materialExtraido + "!" + loteExtraido;
            const oExiste = aItems.find(function (Item) {
                var valorItem = (Item.value || "").toString().trim().toUpperCase();
                if (!valorItem) { return false; }
                var partsItem = valorItem.split('!');
                return partsItem.slice(0, 2).join('!') === sMaterialLoteEscaneado;
            });

            if (oExiste) {
                sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, oExiste.attribute]));
                oInput.setValue(""); oInput.focus();
                return;
            }

            this._validarMaterialYLote(loteExtraido, materialExtraido);

        },
        /**
         * Refresca las cantidades (loteQty) de todos los slots con valor,
         * consultando getReservas para cada lote escaneado. Solo lectura, no persiste nada.
         */
        onPressRefresh: function () {
            var oView = this.getView();
            var oTable = oView.byId("idSlotTable");
            var oModel = oTable.getModel();
            var aItems = oModel.getProperty("/ITEMS") || [];
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oPODParams = this._getPODParamsWithCache();
            if (!oPODParams) { sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots")); return; }
            var mandante = this.getConfiguration().mandante;
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var urlLote = oSapApi + this.ApiPaths.getReservas;

            // Filtrar solo slots con valor
            var aSlotsConValor = aItems.filter(function (slot) {
                return slot.value && slot.value.trim() !== "";
            });

            if (aSlotsConValor.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("sinLotesParaRefrescar"));
                return;
            }

            oView.byId("idPluginPanel").setBusy(true);

            // Crear una promesa por cada slot para consultar su cantidad
            var aPromises = aSlotsConValor.map(function (slot) {
                var parts = slot.value.split('!');
                var sMaterial = (parts[0] || "").trim();
                var sLote = (parts[1] || "").trim();

                var inParams = {
                    "inPlanta": oPODParams.PLANT_ID,
                    "inLote": sLote,
                    "inOrden": oPODParams.ORDER_ID,
                    "inSapClient": mandante,
                    "inMaterial": sMaterial,
                    "inPuesto": oPODParams.WORK_CENTER
                };

                return new Promise(function (resolve) {
                    this.ajaxPostRequest(urlLote, inParams,
                        function (oRes) {
                            slot.loteQty = this._formatLoteQty(oRes.outCantidadLote);
                            slot.loteUom = oRes.outOUMLote || "";
                            resolve({ slot: slot, ok: true });
                        }.bind(this),
                        function () {
                            // Si falla un lote individual, no bloquear los demás
                            resolve({ slot: slot, ok: false });
                        }.bind(this)
                    );
                }.bind(this));
            }.bind(this));

            Promise.all(aPromises).then(function (aResults) {
                oView.byId("idPluginPanel").setBusy(false);
                oModel.refresh(true);
                this._updateOrderSummaryScannedQty(aItems);

                var iFailed = aResults.filter(function (r) { return !r.ok; }).length;
                if (iFailed > 0) {
                    sap.m.MessageToast.show(oBundle.getText("refreshParcial", [iFailed]));
                } else {
                    sap.m.MessageToast.show(oBundle.getText("refreshExitoso"));
                }
            }.bind(this));
        },
        onPressClear: function () {
            const oView = this.getView(),
                oResBun = oView.getModel("i18n").getResourceBundle();
            this.Commons.showConfirmDialog(function () {
                this.clearModel();
            }.bind(this), null, oResBun.getText("clearWarningMessage"));
        },
        clearModel: function () {
            const oView = this.getView();
            const oTable = oView.byId("idSlotTable");
            const oScanInput = oView.byId("scanInput");
            const oModel = oTable.getModel();
            const oPODParams = this._getPODParamsWithCache();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            if (!oPODParams) { sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots")); return; }

            //obtener el modelo actual de la tabla 
            const aItems = oModel.getProperty("/ITEMS") || [];
            if (aItems.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("noDataToClear"));
                return;
            }
            //vaciar los valores manteniendo el attributo
            aItems.forEach(item => {
                item.value = "";  //se vacia solo el valor 
                item.loteQty = "";
            });

            //se acctualiza el modelo de la vista
            oModel.setProperty("/ITEMS", aItems);
            oModel.refresh(true);
            this._updateOrderSummaryScannedQty(aItems);
            oScanInput.setValue("");
            oScanInput.focus();

            // Resetear secuencia cuando se limpian los datos
            this.iSecuenciaCounter = 0;

            //se prepara los datos para hacer el update 
            const aEdited = [
                ...aItems.map(slot => ({ attribute: slot.attribute, value: slot.value }))
            ]

            // Llama a la API para obtener los originales
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const sParams = {
                plant: oPODParams.PLANT_ID,
                workCenter: oPODParams.WORK_CENTER
            };
            //llamado a la API 
            this.getWorkCenterCustomValues(sParams, oSapApi).then(oOriginalRes => {
                const aOriginal = oOriginalRes.customValues || [];
                const aEditMap = {};

                //se crea el mapa de los valores editados (los vacioos)
                aEdited.forEach(item => {
                    aEditMap[item.attribute] = item.value;  //-----------------------------------------------------------------------------
                })
                //combinar los originales con los editados
                const aCustomValuesFinal = aOriginal.map(item => ({
                    attribute: item.attribute,
                    value: aEditMap.hasOwnProperty(item.attribute) ? aEditMap[item.attribute] : item.value
                }));
                // Agregar los que no estaban en el original, los nuevos en este caso los vacios 
                for (const key in aEditMap) {
                    if (!aCustomValuesFinal.find(i => i.attribute === key)) {
                        aCustomValuesFinal.push({ attribute: key, value: aEditMap[key] });
                    }
                }
                //llamar al pp para actualizar los customValues de WC
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                }, oSapApi).then(() => {
                    sap.m.MessageToast.show(oBundle.getText("dataClearedSuccess"));
                    // sap.m.MessageToast.show("Lote actualizado correctamente");
                }).catch(() => {
                    sap.m.MessageToast.show(oBundle.getText("errorClearing"));
                    // En caso de error, recargar los datos originales
                    this.onGetCustomValues();
                });
            }).catch(() => {
                sap.m.MessageToast.show(oBundle.getText("errorObtenerDatosOriginales"));
            });

        },
        /**
         * Obtiene el status de la operación actual desde 3 fuentes en cascada.
         * @returns {string} Status de la operación o cadena vacía si no se encuentra
         */
        _getCurrentOperationStatus: function () {
            var oPodSelectionModel = this.getPodSelectionModel();
            var sCurrentStatus = "";

            // Fuente 1: selectedPhaseData
            if (oPodSelectionModel && oPodSelectionModel.selectedPhaseData) {
                sCurrentStatus = oPodSelectionModel.selectedPhaseData.status || "";
            }

            // Fuente 2: getOperation().operation
            if (!sCurrentStatus) {
                var operation = (oPodSelectionModel && typeof oPodSelectionModel.getOperation === "function")
                    ? (oPodSelectionModel.getOperation() && oPodSelectionModel.getOperation().operation)
                    : null;
                if (!operation && gOperationPhase && gOperationPhase.operation) {
                    operation = gOperationPhase.operation.operation || gOperationPhase.operation;
                }
                if (operation) {
                    sCurrentStatus = operation.status || operation.operationStatus || "";
                }
            }

            // Fuente 3: gOperationPhase directo
            if (!sCurrentStatus && gOperationPhase) {
                sCurrentStatus = gOperationPhase.status || "";
            }

            return sCurrentStatus;
        },
        /**
        * Llamada al Pp(getReservas) para obtener los lotes en Reserva y hacer validacion de material
        * @param {string} sLote - Valor del lote "material!lote" 
        * @param {string} sMaterial - Valor del material "material!lote" 
        * @param {string} bAcActivityValidado - Valor de actividad
        * @returns {string} - Solo el material
        */
        _validarMaterialYLote: function (sLote, sMaterial, bAcActivityValidado) {
            const oView = this.getView();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const mandante = this.getConfiguration().mandante;
            const oPODParams = this._getPODParamsWithCache();
            if (!oPODParams) {
                sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                return;
            }
            const oInput = oView.byId("scanInput");
            const loteEscaneado = sLote;
            const materialEscaneado = sMaterial;
            const puesto = oPODParams.WORK_CENTER;
            const sAcActivity = this.sAcActivity;  //customValue AC_ACTIVITY 
            const bEsPuestoCritico = ["TA01", "TA02", "SL02"].includes(puesto);

            // Validación de estatus de operación (en tiempo real desde POD)
            // var sCurrentStatus = this._getCurrentOperationStatus();
            // if (sCurrentStatus !== OPERATION_STATUS.ACTIVE) {
            //     sap.m.MessageBox.error(oBundle.getText("verificarStatusOperacion"));
            //     return;
            // }

            // validación de actividad (siempre refrescar en puestos críticos)
            if (bEsPuestoCritico && bAcActivityValidado !== true) {
                const oSapApi = this.getPublicApiRestDataSourceUri();
                const sParams = {
                    plant: oPODParams.PLANT_ID,
                    workCenter: oPODParams.WORK_CENTER
                };

                this.getWorkCenterCustomValues(sParams, oSapApi).then(function (oWcData) {
                    const aCustomValues = (oWcData && oWcData.customValues) ? oWcData.customValues : [];
                    const oAcActivity = aCustomValues.find((element) => element.attribute == "AC_ACTIVITY");
                    const sAcActivityRefrescado = (((oAcActivity && oAcActivity.value) || "") + "").trim().toUpperCase();

                    this.sAcActivity = sAcActivityRefrescado;

                    // if (sAcActivityRefrescado !== "SETUP") {
                    //     sap.m.MessageBox.error(oBundle.getText("acActivityNotSetup"));
                    //     return;
                    // }

                    this._validarMaterialYLote(loteEscaneado, materialEscaneado, true);
                }.bind(this));
                return;
            }

            // if (bEsPuestoCritico) {
            //     const sAcActivityNormalizado = ((sAcActivity || "") + "").trim().toUpperCase();
            //     if (sAcActivityNormalizado !== "SETUP") {
            //         sap.m.MessageBox.error(oBundle.getText("acActivityNotSetup"));
            //         return;
            //     }
            // }

            // validacion de material
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const urlMaterial = oSapApi + this.ApiPaths.validateMaterialEnOrden;
            var inParamsMaterial = {
                "inPlanta": oPODParams.PLANT_ID,
                "inLote": loteEscaneado,
                "inOrden": oPODParams.ORDER_ID,
                "inMaterial": materialEscaneado
            };
            oView.byId("idPluginPanel").setBusy(true);

            this.ajaxPostRequest(urlMaterial, inParamsMaterial,
                // SUCCESS callback de validación de material
                function (oResMat) {
                    const matOk = oResMat && (oResMat.outMaterial === true || oResMat.outMaterial === "true");
                    const msgMat = (oResMat && oResMat.outMensaje) || oBundle.getText("materialNoValido");

                    if (!matOk) {
                        oView.byId("idPluginPanel").setBusy(false);
                        sap.m.MessageToast.show(msgMat);
                        if (!this._slotContext) {
                            oInput.setValue("");
                            oInput.focus();
                        }
                        this._slotContext = null;
                        return;
                    }

                    //Validacion de lotes  
                    var urlLote = oSapApi + this.ApiPaths.getReservas;
                    var inParamsLote = {
                        "inPlanta": oPODParams.PLANT_ID,
                        "inLote": loteEscaneado,
                        "inOrden": oPODParams.ORDER_ID,
                        "inSapClient": mandante,
                        "inMaterial": materialEscaneado,
                        "inPuesto": oPODParams.WORK_CENTER
                    };

                    this.ajaxPostRequest(urlLote, inParamsLote,
                        // SUCCESS callback de validación de lote
                        function (oResponseData) {
                            oView.byId("idPluginPanel").setBusy(false);

                            var bEsValido = false;
                            if (oResponseData.outLote === "true" || oResponseData.outLote === true) {
                                bEsValido = true;
                            } else if (oResponseData.outLote === "false" || oResponseData.outLote === false) {
                                bEsValido = false;
                            }

                            if (bEsValido) {
                                const sCantidadLote = this._formatLoteQty(oResponseData.outCantidadLote);
                                const sUomLote = oResponseData.outOUMLote;
                                // Detectar de dónde vino el escaneo
                                if (!this._slotContext) {
                                    // Viene del input superior → buscar slot vacío
                                    // Pasar el barcode capturado ANTES de la validación async para
                                    // evitar race condition si el input fue limpiado durante la espera.
                                    this._ejecutarUpdate(sCantidadLote, sUomLote, materialEscaneado + "!" + loteEscaneado);
                                } else {
                                    // Viene del botón por fila → actualizar ese slot
                                    this._slotContext.loteQty = sCantidadLote;
                                    this._procesarSlotValidado(sCantidadLote, sUomLote);
                                }
                            } else {
                                sap.m.MessageToast.show(oBundle.getText("loteNoValido"));
                                // Solo limpiar input si viene del input superior
                                if (!this._slotContext) {
                                    oInput.setValue("");
                                    oInput.focus();
                                }
                                // Limpiar contexto siempre
                                this._slotContext = null;
                            }
                        }.bind(this),
                        // ERROR callback de validación de lote
                        function (oError, sHttpErrorMessage) {
                            oView.byId("idPluginPanel").setBusy(false);
                            var err = oError || sHttpErrorMessage;
                            sap.m.MessageToast.show(oBundle.getText("errorValidarLote", [err]));

                            // Solo limpiar input si viene del input superior
                            if (!this._slotContext) {
                                oInput.setValue("");
                                oInput.focus();
                            }
                            // Limpiar contexto siempre
                            this._slotContext = null;
                        }.bind(this)
                    );
                }.bind(this),
                // ERROR callback de validación de material
                function (oError, sHttpErrorMessage) {
                    oView.byId("idPluginPanel").setBusy(false);
                    sap.m.MessageToast.show(oBundle.getText("errorValidacionMaterial", [sHttpErrorMessage || ""]));
                    // Solo limpiar input si viene del input superior
                    if (!this._slotContext) {
                        oInput.setValue("");
                        oInput.focus();
                    }
                    // Limpiar contexto siempre
                    this._slotContext = null;
                }.bind(this)
            );
        },
        _formatLoteQty: function (vCantidad) {
            var n = parseFloat(vCantidad);
            return isNaN(n) ? "" : n.toFixed(2);
        },
        /**
         * Devuelve los POD params usando caché si el POD perdió contexto por navegación.
         * @returns {Object|null} params o null si no hay contexto ni caché
         */
        _getPODParamsWithCache: function () {
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            if (!oPODParams.WORK_CENTER && this._oCachedPODParams) {
                return this._oCachedPODParams;
            } else if (oPODParams.WORK_CENTER) {
                this._oCachedPODParams = oPODParams;
                return oPODParams;
            }
            return null;
        },
        /**
         * Refresca el modelo de la tabla consultando los customValues del puesto de trabajo desde el backend.
         * 
         * Este método garantiza que ANTES de cualquier operación de escritura (_ejecutarUpdate,
         * _procesarSlotValidado, onDeleteSlot), la tabla refleje el estado REAL del backend.
         * @returns {Promise<{slots: Array, customValues: Array}|null>} null si hubo error
         */
        _refreshSlotsFromBackend: function () {
            var oView = this.getView();
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var oTable = oView.byId("idSlotTable");
            var oPODParams = this._getPODParamsWithCache();
            if (!oPODParams) { return Promise.resolve(null); }
            var sParams = {
                plant: oPODParams.PLANT_ID,
                workCenter: oPODParams.WORK_CENTER
            };

            // Preservar loteQty del modelo actual antes de sobreescribir
            var oCurrentModel = oTable.getModel();
            var aCurrentItems = (oCurrentModel && oCurrentModel.getProperty("/ITEMS")) || [];
            var oLoteDataMap = {};
            aCurrentItems.forEach(function (item) {
                if (item.value) {
                    var parts = item.value.split('!');
                    var key = parts.slice(0, 2).join('!').toUpperCase();
                    oLoteDataMap[key] = { loteQty: item.loteQty || "", loteUom: item.loteUom || "" };
                }
            });

            return this.getWorkCenterCustomValues(sParams, oSapApi).then(function (oData) {
                if (!oData || oData === "Error" || !oData.customValues) {
                    return null;
                }

                var aCustomValues = oData.customValues;
                // Lista dinámica OA: solo slots con valor (los vacíos de eliminaciones se ignoran)
                var aSlotsFixed = aCustomValues.filter(function (item) {
                    return item.attribute.startsWith("SLOT") &&
                        item.attribute !== "SLOTQTY" &&
                        item.attribute !== "SLOTTIPO" &&
                        item.value && item.value.trim() !== "";
                });

                // Restaurar loteQty y loteUom desde el modelo anterior (matching por material!lote)
                aSlotsFixed.forEach(function (slot) {
                    if (slot.value) {
                        var parts = slot.value.split('!');
                        var key = parts.slice(0, 2).join('!').toUpperCase();
                        var oLoteData = oLoteDataMap[key] || {};
                        slot.loteQty = oLoteData.loteQty || "";
                        slot.loteUom = oLoteData.loteUom || "";
                    } else {
                        slot.loteQty = "";
                        slot.loteUom = "";
                    }
                });

                // Actualizar tabla con datos frescos
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aSlotsFixed }));
                this._updateOrderSummaryScannedQty(aSlotsFixed);

                // Resincronizar contador de secuencia
                var iSlotsConValor = aSlotsFixed.filter(function (s) {
                    return s.value && s.value.trim() !== "";
                }).length;
                if (iSlotsConValor === 0) {
                    this.iSecuenciaCounter = 0;
                } else {
                    var maxSecuencia = Math.max.apply(null, aSlotsFixed
                        .filter(function (s) { return s.value; })
                        .map(function (s) {
                            var parts = (s.value || "").split('!');
                            return parseInt(parts[parts.length - 1] || 0);
                        })
                    );
                    this.iSecuenciaCounter = maxSecuencia;
                }

                return { slots: aSlotsFixed, customValues: aCustomValues };
            }.bind(this));
        },
        /**
         * Asigna el barcode escaneado (desde input superior) al primer slot vacío.
         * FLUJO: _refreshSlotsFromBackend() → validar duplicados → asignar slot vacío → merge → POST
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         */
        _ejecutarUpdate: function (sCantidadLote, sUomLote, sBarcodeIn) {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            // Usar el barcode capturado antes de la validación async (evita race condition
            // si el input fue limpiado mientras se esperaba la respuesta del servidor).
            const sBarcode = (sBarcodeIn || oInput.getValue()).trim();
            const oPODParams = this._getPODParamsWithCache();
            const oBundle = oView.getModel("i18n").getResourceBundle();
            if (!oPODParams) {
                sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                return;
            }

            // Refrescar desde backend antes de operar para evitar datos stale
            this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    oInput.setValue("");
                    oInput.focus();
                    return;
                }

                // Usar oRefresh.slots (datos del propio refresh) para evitar race condition
                // con onGetCustomValues que puede reemplazar el modelo de tabla concurrentemente.
                const aItems = oRefresh.slots;

                // Extraer material!lote del barcode escaneado (ignorar secuencia si existe)
                const sNormalizado = sBarcode.toUpperCase();
                const partsEscaneado = sNormalizado.split('!');
                const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!');

                // Buscar si ya existe un item con el mismo material!lote (datos frescos)
                const oExiste = aItems.find(function (Item) {
                    const valorItem = (Item.value || "").toString().trim().toUpperCase();
                    if (!valorItem) return false;
                    const partsItem = valorItem.split('!');
                    const materialLoteItem = partsItem.slice(0, 2).join('!');
                    return materialLoteItem === materialLoteEscaneado;
                });

                if (oExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, oExiste.attribute]));
                    oInput.setValue("");
                    oInput.focus();
                    return;
                }

                // Tabla dinámica OA: oRefresh.slots solo contiene slots con valor.
                // Siempre se añade un nuevo slot al final (no hay huecos/placeholders).
                this.iSecuenciaCounter++;
                const sNextAttr = "SLOT" + this.iSecuenciaCounter.toString().padStart(3, "0");
                aItems.push({
                    attribute: sNextAttr,
                    value: sBarcode + "!" + this.iSecuenciaCounter,
                    loteQty: sCantidadLote || "",
                    loteUom: sUomLote || ""
                });

                const oTable = oView.byId("idSlotTable");
                const oModel = oTable.getModel();
                oModel.setProperty("/ITEMS", aItems);
                oModel.refresh(true);
                this._updateOrderSummaryScannedQty(aItems);

                oInput.setValue("");
                oInput.focus();

                // Payload simplificado: CVs no-slot del backend + todos los slots con valor.
                // OA no necesita SLOTQTY en el payload.
                const aFilledSlots = aItems
                    .filter(function (s) { return s.value && s.value.trim() !== ""; })
                    .map(function (s) { return { attribute: s.attribute, value: s.value }; });

                const aNonSlotCvs = (oRefresh.customValues || []).filter(function (cv) {
                    return !cv.attribute.startsWith("SLOT") &&
                        cv.attribute !== "SLOTQTY" &&
                        cv.value && cv.value.trim() !== "";
                });

                const aCustomValuesFinal = [
                    ...aNonSlotCvs,
                    ...aFilledSlots
                ];

                const sMaterialLote = materialLoteEscaneado || "";
                const oSapApi = this.getPublicApiRestDataSourceUri();
                console.log("[NB-OA scan] payload customValues:", JSON.stringify(aCustomValuesFinal));
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inMaterialLote: sMaterialLote
                }, oSapApi).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("slotActualizado"));
                }).catch(function (oErr) {
                    var sErrMsg = (oErr && oErr.responseJSON && (oErr.responseJSON.message || oErr.responseJSON.displayMessage)) || oBundle.getText("errorActualizar");
                    console.error("[NB-OA] Error al guardar slot:", oErr);
                    sap.m.MessageToast.show(sErrMsg);
                    this._refreshSlotsFromBackend();
                }.bind(this));
            }.bind(this));
        },
        onScanSuccess: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show(oBundle.getText("scanCancelled"), { duration: 1000 });
            } else {
                if (oEvent.getParameter("text")) {
                    this.oScanInput.setValue(oEvent.getParameter("text"));
                    this.onBarcodeSubmit();
                } else {
                    this.oScanInput.setValue('');
                }
            }
        },
        onScanError: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            sap.m.MessageToast.show(oBundle.getText("scanFailed", [oEvent]), { duration: 1000 });
        },
        onScanLiveupdate: function (oEvent) {
            if (this._oScanDebounceTimer) {
                clearTimeout(this._oScanDebounceTimer);
            }
            this._oScanDebounceTimer = setTimeout(function () {
                this._oScanDebounceTimer = null;
                this.onBarcodeSubmit();
            }.bind(this), 100);
        },
        /**
         * Elimina un lote de la tabla y recorre los posteriores hacia arriba.
         * 
         * FLUJO: Capturar valor a eliminar → _refreshSlotsFromBackend() → buscar valor en datos
         *        frescos → eliminar y recorrer → renumerar secuencias → merge → POST
         * 
         */
        onDeleteSlot: function (oEvent) {
            const oView = this.getView();
            const oTable = this.byId("idSlotTable");
            const oModel = oTable.getModel();
            const oPODParams = this._getPODParamsWithCache();
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            if (!oPODParams) { sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots")); return; }

            // Capturar el valor del slot a eliminar ANTES del refresh (la ref DOM puede cambiar)
            const oItem = oEvent.getSource().getParent();
            const iCurrentIndex = oTable.indexOfItem(oItem);
            if (iCurrentIndex === -1) {
                return;
            }
            const aCurrentSlots = oModel.getProperty("/ITEMS") || [];
            const sValueToDelete = ((aCurrentSlots[iCurrentIndex] && aCurrentSlots[iCurrentIndex].value) || "").trim();
            if (!sValueToDelete) {
                return;
            }

            // Refrescar desde backend antes de operar para evitar datos stale
            this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    return;
                }

                const oFreshModel = oTable.getModel();
                var aSlots = oFreshModel.getProperty("/ITEMS") || [];

                // Buscar el slot con el valor a eliminar en datos frescos
                const iIndex = aSlots.findIndex(function (s) {
                    return (s.value || "").trim() === sValueToDelete;
                });

                if (iIndex === -1) {
                    // Ya fue eliminado externamente
                    sap.m.MessageToast.show(oBundle.getText("loteYaEliminado"));
                    return;
                }

                // Eliminar y recorrer hacia arriba
                for (var i = iIndex; i < aSlots.length - 1; i++) {
                    aSlots[i].value = aSlots[i + 1].value;
                    aSlots[i].loteQty = aSlots[i + 1].loteQty;
                    aSlots[i].loteUom = aSlots[i + 1].loteUom;
                }
                aSlots[aSlots.length - 1].value = "";
                aSlots[aSlots.length - 1].loteQty = "";
                aSlots[aSlots.length - 1].loteUom = "";

                // Renumerar secuencia (preservar CANTIDAD si existe: MAT!LOTE!CANTIDAD!SEQ)
                var iNuevaSecuencia = 0;
                aSlots.forEach(function (slot) {
                    var sValorActual = ((slot && slot.value) || "").toString().trim();
                    if (!sValorActual) { return; }
                    var aPartes = sValorActual.split('!');
                    if (aPartes.length >= 2) {
                        iNuevaSecuencia++;
                        var sCantidad = aPartes.length >= 4 ? aPartes[2] : (slot.cantidadAsignada || "");
                        slot.value = aPartes[0] + "!" + aPartes[1] + (sCantidad ? "!" + sCantidad : "") + "!" + iNuevaSecuencia;
                    }
                });
                this.iSecuenciaCounter = iNuevaSecuencia;

                oFreshModel.setProperty("/ITEMS", aSlots);
                oFreshModel.refresh(true);
                this._updateOrderSummaryScannedQty(aSlots);

                sap.m.MessageToast.show(oBundle.getText("loteEliminado"));

                var aEdited = aSlots.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; });

                // Merge con customValues frescos (ya obtenidos en el refresh)
                var aOriginal = oRefresh.customValues;
                var editedMap = {};
                aEdited.forEach(function (item) { editedMap[item.attribute] = item.value; });

                var aCustomValuesFinal = aOriginal.map(function (item) {
                    return {
                        attribute: item.attribute,
                        value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                    };
                });

                for (var key in editedMap) {
                    if (!aCustomValuesFinal.find(function (i) { return i.attribute === key; })) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }

                var partsDeleted = sValueToDelete.split('!');
                var sMaterialLoteDeleted = partsDeleted.slice(0, 2).join('!');
                var oSapApi = this.getPublicApiRestDataSourceUri();
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inMaterialLote: sMaterialLoteDeleted
                }, oSapApi).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("loteActualizadoAntesEliminar"));
                }).catch(function (oErr) {
                    var sErrMsg = (oErr && oErr.responseJSON && (oErr.responseJSON.message || oErr.responseJSON.displayMessage)) || oBundle.getText("errorActualizarTrasEliminar");
                    console.error("[putBatchSlotWC-delete] Error al eliminar slot:", oErr);
                    sap.m.MessageBox.error(sErrMsg);
                    this._refreshSlotsFromBackend();
                }.bind(this));
            }.bind(this));
        },
        /**
         * Callback del escáner por fila (botón de escaneo en cada ColumnListItem).
         * Valida formato del barcode, captura el atributo del slot destino (ej: "SLOT005")
         * y lanza la validación de material+lote. Al pasar, continúa en _procesarSlotValidado.
         * 
         * NOTA: Se guarda slotAttribute (no referencia DOM) en _slotContext porque tras el
         *   refresh del backend el DOM se reconstruye y la referencia de oEvent sería stale.
         */
        onScanSlotSuccess: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show(oBundle.getText("scanCancelled"), { duration: 1000 });
                return;
            }
            const sBarcode = (oEvent.getParameter("text") || "").trim();
            if (!sBarcode) { return; }

            const parts = sBarcode.toUpperCase().split('!');
            if (parts.length < 2 || !parts[0] || !parts[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                return;
            }

            const sMaterial = parts[0].trim();
            const sLote = parts[1].trim();

            // Capturar atributo del slot antes de validación (la referencia DOM puede cambiar tras refresh)
            const oButton = oEvent.getSource();
            const oSlotItem = oButton.getParent();
            const oTable = this.byId("idSlotTable");
            const iSlotIndex = oTable.indexOfItem(oSlotItem);
            const oSlotModel = oTable.getModel();
            const aCurrentSlots = (oSlotModel && oSlotModel.getProperty("/ITEMS")) || [];
            const sSlotAttribute = (iSlotIndex >= 0 && aCurrentSlots[iSlotIndex]) ? aCurrentSlots[iSlotIndex].attribute : null;

            // Guarda contexto para actualizar la fila cuando ambas validaciones pasen
            this._slotContext = { oEvent: oEvent, sBarcode: sBarcode, loteExtraido: sLote, slotAttribute: sSlotAttribute };

            // Reutiliza la validación combinada
            this._validarMaterialYLote(sLote, sMaterial);
        },
        /**
         * Procesa la asignación de un barcode validado a un slot específico (escaneo por fila).
         * 
         * FLUJO: _refreshSlotsFromBackend() → localizar slot por atributo → validar duplicados
         *        → asignar valor+secuencia → merge con customValues frescos → POST
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         */
        _procesarSlotValidado: function (sCantidadLote, sUomLote) {
            if (!this._slotContext) {
                const oBundle = this.getView().getModel("i18n").getResourceBundle();
                console.error(oBundle.getText("noContextoSlot"));
                return;
            }

            const { sBarcode, slotAttribute } = this._slotContext;
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oPODParams = this._getPODParamsWithCache();
            if (!oPODParams) { sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots")); this._slotContext = null; return; }

            // Refrescar desde backend antes de operar para evitar datos stale
            this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                // Usar oRefresh.slots (datos del propio refresh) para evitar race condition
                // con onGetCustomValues que puede reemplazar el modelo de tabla concurrentemente.
                const aSlots = oRefresh.slots;
                const oTable = this.byId("idSlotTable");
                const oModel = oTable.getModel();

                // Encontrar el slot destino por atributo (no por referencia DOM que puede ser stale)
                const iIndex = aSlots.findIndex(function (s) { return s.attribute === slotAttribute; });
                if (iIndex === -1 || !aSlots[iIndex]) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                const sNormalizado = sBarcode.toUpperCase();
                const partsEscaneado = sNormalizado.split('!');
                const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!');

                // Buscar duplicados en datos frescos
                const sExiste = aSlots.find(function (slot, idx) {
                    if (idx === iIndex) return false;
                    const valorSlot = (slot.value || "").toString().trim().toUpperCase();
                    if (!valorSlot) return false;
                    const partsSlot = valorSlot.split('!');
                    const materialLoteSlot = partsSlot.slice(0, 2).join('!');
                    return materialLoteSlot === materialLoteEscaneado;
                });

                if (sExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, sExiste.attribute]));
                    this._slotContext = null;
                    return;
                }

                // Si el valor ya es el mismo en esa fila, no actualizar
                const valorActual = (aSlots[iIndex].value || "").toString().trim().toUpperCase();
                if (valorActual) {
                    const partsActual = valorActual.split('!');
                    const materialLoteActual = partsActual.slice(0, 2).join('!');
                    if (materialLoteActual === materialLoteEscaneado) {
                        sap.m.MessageToast.show(oBundle.getText("sinCambios"));
                        this._slotContext = null;
                        return;
                    }
                }

                const iSlotsConValor = aSlots.filter(function (slot) {
                    return slot.value && slot.value.trim() !== "";
                }).length;
                if (iSlotsConValor === 0) {
                    this.iSecuenciaCounter = 0;
                }

                this.iSecuenciaCounter++;
                aSlots[iIndex].value = sBarcode + "!" + this.iSecuenciaCounter;
                aSlots[iIndex].loteQty = sCantidadLote || "";
                aSlots[iIndex].loteUom = sUomLote || "";

                oModel.setProperty("/ITEMS", aSlots);
                oModel.refresh(true);
                this._updateOrderSummaryScannedQty(aSlots);

                // Payload simplificado: CVs no-slot del backend + slots con valor.
                const aFilledSlotsRow = aSlots
                    .filter(function (s) { return s.value && s.value.trim() !== ""; })
                    .map(function (s) { return { attribute: s.attribute, value: s.value }; });

                const aNonSlotCvsRow = (oRefresh.customValues || []).filter(function (cv) {
                    return !cv.attribute.startsWith("SLOT") &&
                        cv.attribute !== "SLOTQTY" &&
                        cv.value && cv.value.trim() !== "";
                });

                const aCustomValuesFinal = [
                    ...aNonSlotCvsRow,
                    ...aFilledSlotsRow
                ];

                const sMaterialLote = materialLoteEscaneado || "";
                const oSapApi = this.getPublicApiRestDataSourceUri();
                console.log("[NB-OA scanRow] payload customValues:", JSON.stringify(aCustomValuesFinal));
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inMaterialLote: sMaterialLote
                }, oSapApi).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("slotActualizado"));
                    this._slotContext = null;
                }.bind(this)).catch(function (oErr) {
                    var sErrMsg = (oErr && oErr.responseJSON && (oErr.responseJSON.message || oErr.responseJSON.displayMessage)) || oBundle.getText("errorActualizar");
                    console.error("[NB-OA-slotRow] Error al guardar slot:", oErr);
                    sap.m.MessageToast.show(sErrMsg);
                    this._slotContext = null;
                    this._refreshSlotsFromBackend();
                }.bind(this));
            }.bind(this));
        },
        //>>>>>>>   EN HONOR A GS 
        summarizeByErpSequence: function (input) {
            var result = [];
            var groups = {};
            var comps = input;
            var i = 0;

            while (i < comps.length) {
                var c = comps[i];
                var key = c.erpSequence;

                // Crear grupo si no existe
                if (!groups[key]) {
                    groups[key] = {
                        erpSequence: key,
                        material: c.material, // objeto completo
                        assemblyOperationActivity: c.assemblyOperationActivity, // objeto completo
                        componentType: c.componentType,
                        unitOfMeasure: c.unitOfMeasure,
                        reservationOrderNumber: c.reservationOrderNumber,
                        sequence: c.sequence,   // inicializar con la primera sequence encontrada
                        quantity: 0,
                        totalQuantity: 0,
                        batchNumber: "",
                        reservationItemNumber: ""
                    };
                }
                // Actualizar mínima sequence
                if (c.sequence < groups[key].sequence) {
                    groups[key].sequence = c.sequence;
                }
                // Acumular cantidades
                groups[key].quantity = groups[key].quantity + c.quantity;
                groups[key].totalQuantity = groups[key].totalQuantity + c.totalQuantity;

                i = i + 1;
            }
            // Convertir grupos a arreglo
            for (var g in groups) {
                result[result.length] = groups[g];
            }
            return result;
        },
        //>>>>>>>
        onBeforeRenderingPlugin: function () {
            // Inicializar gOperationPhase desde POD para capturar estado inicial
            var oPodSelectionModel = this.getPodSelectionModel();
            if (oPodSelectionModel && oPodSelectionModel.selectedPhaseData) {
                var sStatus = oPodSelectionModel.selectedPhaseData.status || "";
                gOperationPhase = {
                    status: sStatus
                };
            }

            this.subscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
            this.onGetCustomValues();
        },
        onPhaseSelectionEventCustom: function (sChannelId, sEventId, oData) {
            if (this.isEventFiredByThisPlugin(oData)) {
                return;
            }
            gOperationPhase = oData;
            this.onGetCustomValues();
            this.setOrderSummary();

        },
        isSubscribingToNotifications: function () {
            var bNotificationsEnabled = true;
            return bNotificationsEnabled;
        },
        getCustomNotificationEvents: function (sTopic) {
            //return ["template"];
        },
        getNotificationMessageHandler: function (sTopic) {
            //if (sTopic === "template") {
            //    return this._handleNotificationMessage;
            //}
            return null;
        },
        _handleNotificationMessage: function (oMsg) {

            var sMessage = "Message not found in payload 'message' property";
            if (oMsg && oMsg.parameters && oMsg.parameters.length > 0) {
                for (var i = 0; i < oMsg.parameters.length; i++) {

                    switch (oMsg.parameters[i].name) {
                        case "template":

                            break;
                        case "template2":
                            break;
                    }
                }
            }
        },
        onExit: function () {
            PluginViewController.prototype.onExit.apply(this, arguments);

            this.unsubscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
        },
        setOrderSummary: function () {
            var oPODParams = this._getPODParamsWithCache();
            if (!oPODParams) { return; }
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const order = oPODParams.ORDER_ID;
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oParams = {
                plant: oPODParams.PLANT_ID,
                bom: oPODParams.BOM_ID,
                type: "SHOP_ORDER"
            };

            this.getOrderSummary(oParams, oSapApi)
                .then(function (data) {
                    const oBomData = Array.isArray(data) ? data[0] : data;
                    const aComponents = (oBomData && Array.isArray(oBomData.components)) ? oBomData.components : [];

                    // Filtrar todos los componentes NORMAL y agrupar por erpSequence
                    const aNormalComponents = aComponents.filter(function (oComp) {
                        return oComp && oComp.componentType === "NORMAL";
                    });

                    // Guardar para el popover de consulta de lotes asignados en la BOM
                    this._aBomNormalComponents = aNormalComponents;

                    if (!aNormalComponents.length) {
                        console.warn("[OrderSummary] No se encontró componente NORMAL en BOMS", oBomData);
                        return;
                    }

                    // Tomar solo los componentes NORMAL que tienen lote asignado en la BOM
                    // (algunos componentes NORMAL pueden venir sin batchNumber)
                    const aNormalConLote = aNormalComponents.filter(function (oComp) {
                        return oComp.batchNumber && oComp.batchNumber.trim() !== "";
                    });
                    // Si ninguno tiene lote, usar todos (fallback)
                    const aBaseParaSummary = aNormalConLote.length > 0 ? aNormalConLote : aNormalComponents;

                    // Agrupar por erpSequence y sumar totalQuantity de los componentes con lote
                    const sBatch = (aBaseParaSummary[0].batchNumber || "").toString().trim();
                    const aGrouped = this.summarizeByErpSequence(aBaseParaSummary);
                    const oPrimerGrupo = aGrouped[0] || {};

                    const oOrderSummaryModel = this.getView().getModel("orderSummary");
                    const sMaterial = (oPrimerGrupo.material && oPrimerGrupo.material.material) || "";
                    const sUom = oPrimerGrupo.unitOfMeasure || "";
                    // cantidadNecesaria = suma de totalQuantity de todos los grupos
                    const nCantidadNecesaria = aGrouped.reduce(function (nSum, oGrupo) {
                        return nSum + Number(oGrupo.totalQuantity || 0);
                    }, 0);

                    // oOrderSummaryModel.setProperty("/lote", sBatch);
                    oOrderSummaryModel.setProperty("/material", sMaterial);
                    oOrderSummaryModel.setProperty("/cantidadNecesaria", nCantidadNecesaria);
                    oOrderSummaryModel.setProperty("/unidadMedida", sUom);

                    this.getHeaderMaterial({ material: sMaterial, plant: oPODParams.PLANT_ID }, oSapApi)
                        .then(function (headerData) {
                            const oHeader = Array.isArray(headerData) ? headerData[0] : headerData;
                            const sDescripcion = (oHeader && oHeader.description) || "";
                            oOrderSummaryModel.setProperty("/descripcion", sDescripcion);

                        }.bind(this))
                        .catch(function (error) {
                            console.error("[OrderSummary Test] Error:", error);
                            sap.m.MessageToast.show(oBundle.getText("errorObtenerHeaderMaterial", [sMaterial]));
                        }.bind(this));

                    this._updateOrderSummaryScannedQty();
                }.bind(this))
                .catch(function (error) {
                    console.error("[OrderSummary Test] Error:", error);
                    sap.m.MessageToast.show(oBundle.getText("errorObtenerBom", [order]));
                }.bind(this));
        },
        _updateOrderSummaryScannedQty: function (aItems) {
            const oOrderSummaryModel = this.getView().getModel("orderSummary");
            if (!oOrderSummaryModel) {
                return;
            }

            let aSourceItems = aItems;
            if (!Array.isArray(aSourceItems)) {
                const oTable = this.byId("idSlotTable");
                const oTableModel = oTable && oTable.getModel();
                aSourceItems = (oTableModel && oTableModel.getProperty("/ITEMS")) || [];
            }

            const nScannedQty = aSourceItems.reduce(function (nTotal, oItem) {
                const nQty = parseFloat(oItem && oItem.loteQty);
                return nTotal + (isNaN(nQty) ? 0 : nQty);
            }, 0);

            oOrderSummaryModel.setProperty("/cantidadEscaneada", Number(nScannedQty.toFixed(2)));
        },
        onPressOpenFragmentList: function (oEvent) {
            var oView = this.getView();
            var oSource = oEvent.getSource();
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oPODParams = this._getPODParamsWithCache();
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var self = this;

            if (!oPODParams) {
                sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                return;
            }

            if (!this._aBomNormalComponents || !this._aBomNormalComponents.length) {
                sap.m.MessageToast.show(oBundle.getText("errorObtenerBom", [""]));
                return;
            }

            // Filtrar lotes ya escaneados en la tabla
            var oSlotTable = oView.byId("idSlotTable");
            var aScannedSlots = (oSlotTable && oSlotTable.getModel())
                ? (oSlotTable.getModel().getProperty("/ITEMS") || []) : [];
            var oScannedSet = {};
            aScannedSlots.forEach(function (slot) {
                if (slot.value && slot.value.trim()) {
                    oScannedSet[slot.value.toUpperCase().split("!").slice(0, 2).join("!")] = true;
                }
            });

            // Obtener material del primer componente BOM CON lote asignado para la consulta GI
            var oCompConLoteBom = self._aBomNormalComponents.find(function (oComp) {
                return oComp.batchNumber && oComp.batchNumber.trim() !== "";
            }) || self._aBomNormalComponents[0];
            var sMaterialBom = (oCompConLoteBom && oCompConLoteBom.material && oCompConLoteBom.material.material) || "";

            var fnBuildAndShow = function (oDialog) {
                oDialog.setModel(new JSONModel({ ITEMS: [] }));
                oDialog.setBusy(true);

                var oGiParams = {
                    order: oPODParams.ORDER_ID,
                    material: sMaterialBom,
                    materialVersion: "ERP001",
                    plant: oPODParams.PLANT_ID,
                    size: 500
                };

                self.getGoodsIssueSummaryMaterial(oGiParams, oSapApi).then(function (oGiRes) {
                    // Construir mapa de consumo: batchNumber.toUpperCase() → cantidad total consumida
                    var oConsumedMap = {};
                    var aGiContent = (oGiRes && Array.isArray(oGiRes.content)) ? oGiRes.content
                        : (Array.isArray(oGiRes) ? oGiRes : []);
                    aGiContent.forEach(function (oGi) {
                        if (oGi.postingType === "GI" && oGi.batchNumber) {
                            var sKey = oGi.batchNumber.trim().toUpperCase();
                            var nQty = parseFloat((oGi.quantityInBaseUnit && oGi.quantityInBaseUnit.value) || 0);
                            oConsumedMap[sKey] = (oConsumedMap[sKey] || 0) + nQty;
                        }
                    });

                    var aItems = self._aBomNormalComponents
                        .filter(function (oComp) {
                            var sMat = (oComp.material && oComp.material.material) || "";
                            var sLote = oComp.batchNumber || "";
                            // Excluir componentes sin lote asignado en la BOM
                            if (!sLote || !sLote.trim()) { return false; }
                            // Excluir lotes ya escaneados en la tabla
                            if (oScannedSet[(sMat + "!" + sLote).toUpperCase()]) { return false; }
                            // Excluir lotes completamente consumidos
                            var nTotal = parseFloat(oComp.totalQuantity || 0);
                            var nConsumed = oConsumedMap[sLote.trim().toUpperCase()] || 0;
                            return nConsumed < nTotal;
                        })
                        .map(function (oComp) {
                            var sMat = (oComp.material && oComp.material.material) || "";
                            var sLote = oComp.batchNumber || "";
                            var nTotal = parseFloat(oComp.totalQuantity || 0);
                            var nConsumed = oConsumedMap[sLote.trim().toUpperCase()] || 0;
                            var nRemaining = Math.max(0, nTotal - nConsumed);
                            return { MATERIAL: sMat, LOTE: sLote, CANTIDAD: nRemaining.toFixed(2), CODIGO: sMat + "!" + sLote };
                        });

                    oDialog.setBusy(false);
                    oDialog.setModel(new JSONModel({ ITEMS: aItems }));
                }).catch(function () {
                    // Fallback si la API falla: mostrar lotes BOM sin filtro de consumo
                    oDialog.setBusy(false);
                    var aFallback = self._aBomNormalComponents
                        .filter(function (oComp) {
                            var sMat = (oComp.material && oComp.material.material) || "";
                            var sLote = oComp.batchNumber || "";
                            // Excluir componentes sin lote asignado en la BOM
                            if (!sLote || !sLote.trim()) { return false; }
                            return !oScannedSet[(sMat + "!" + sLote).toUpperCase()];
                        })
                        .map(function (oComp) {
                            var sMat = (oComp.material && oComp.material.material) || "";
                            var sLote = oComp.batchNumber || "";
                            var nQty = parseFloat(oComp.totalQuantity || 0);
                            return { MATERIAL: sMat, LOTE: sLote, CANTIDAD: nQty.toFixed(2), CODIGO: sMat + "!" + sLote };
                        });
                    oDialog.setModel(new JSONModel({ ITEMS: aFallback }));
                });
            };

            if (!this.byId("batchListDialog")) {
                Fragment.load({
                    id: oView.getId(),
                    name: "serviacero.custom.plugins.zpluginPutBatchWCNB.zpluginPutBatchWCNB.fragment.batchList",
                    controller: this
                }).then(function (oPopover) {
                    oView.addDependent(oPopover);
                    oPopover.openBy(oSource);
                    fnBuildAndShow(oPopover);
                });
            } else {
                var oDialog = this.byId("batchListDialog");
                oDialog.openBy(oSource);
                fnBuildAndShow(oDialog);
            }
        },
        onConfirmSendBatchChars: function () {
            var oPopover = this.byId("batchListDialog");
            if (oPopover) { oPopover.close(); }
        },
        onCopiarCodigo: function (oEvent) {
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            var oContext = oEvent.getSource().getBindingContext();
            var sCodigo = oContext ? oContext.getProperty("CODIGO") : "";
            if (!sCodigo) { return; }
            navigator.clipboard.writeText(sCodigo).then(function () {
                sap.m.MessageToast.show(oBundle.getText("codigoCopiado", [sCodigo]));
            }).catch(function () {
                // Fallback para navegadores sin soporte clipboard API
                var oInput = document.createElement("input");
                oInput.value = sCodigo;
                document.body.appendChild(oInput);
                oInput.select();
                document.execCommand("copy");
                document.body.removeChild(oInput);
                sap.m.MessageToast.show(oBundle.getText("codigoCopiado", [sCodigo]));
            });
        },
        //Funcion que cierra el fragmento de inventario almacen 
        onCloseDialogBatchChars: function (oEvent) {
            var oDialog = this.byId("batchListDialog");
            if (oDialog) { oDialog.close(); }
        },
        // Limpia el estado busy al cerrar el popover (por cualquier causa: X, clic fuera, boton)
        onAfterClosePopoverInventario: function () {
            var oPopover = this.byId("batchListDialog");
            if (oPopover && !oPopover.bIsDestroyed) {
                oPopover.setBusy(false);
            }
        },
        getGoodsIssuesSummary: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.GOODSISSUES_SUMMARY, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        getGoodsIssueSummaryMaterial: function (sParams, oSapApi) {
            return new Promise(function (resolve, reject) {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.GOODSISSUES_SUMMARY_MATERIAL, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this), function (oRes) {
                    reject(oRes);
                }.bind(this));
            }.bind(this));
        },
        getHeaderMaterial: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.HEADER_MATERIAL, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        getOrderSummary: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.BOMS, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        /**
         * Lee los customValues de la Actividad de Operación (OPERATION_ACTIVITIES).
         * Guarda _oOperationActivityData para que setCustomValuesPp pueda construir el inData.
         * Devuelve { customValues: [...] } con el mismo formato que antes esperaban los callers.
         */
        getWorkCenterCustomValues: function (sParams, oSapApi) {
            var oPODParams = this._getPODParamsWithCache();
            return new Promise(function (resolve) {
                var oQueryParams = {
                    plant: (sParams && sParams.plant) || (oPODParams && oPODParams.PLANT_ID),
                    operation: oPODParams && oPODParams.OPERATION_ACTIVITY
                };
                this.ajaxGetRequest(oSapApi + this.ApiPaths.OPERATION_ACTIVITIES, oQueryParams, function (oRes) {
                    var aContent = (oRes && oRes.content) || [];
                    var oData = aContent[0];
                    if (!oData) {
                        resolve("Error");
                        return;
                    }
                    this._oOperationActivityData = oData;
                    resolve({ customValues: oData.customValues || [] });
                }.bind(this),
                    function () {
                        resolve("Error");
                    }.bind(this));
            }.bind(this));
        },
        /**
         * Persiste customValues en la Actividad de Operación usando putBatchSlotOperationActivity.
         * Construye el payload inData usando _oOperationActivityData (operación, planta, versión).
         * @param {Object} oParams - { inCustomValues: Array, inPlant, ... }
         */
        setCustomValuesPp: function (oParams, oSapApi) {
            var oOAData = this._oOperationActivityData;
            var oPODParams = this._getPODParamsWithCache();
            var oPayload = {
                inData: [{
                    plant: (oOAData && oOAData.plant) || (oPODParams && oPODParams.PLANT_ID),
                    operation: (oOAData && oOAData.operation) || (oPODParams && oPODParams.OPERATION_ACTIVITY),
                    version: (oOAData && oOAData.version) || "",
                    customValues: oParams.inCustomValues
                }]
            };
            return new Promise(function (resolve, reject) {
                this.ajaxPostRequest(oSapApi + this.ApiPaths.putBatchSlotOperationActivity, oPayload, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            }.bind(this));
        },
    });
});