class ViewManager {
    constructor(container, views, view_groups, view_url, image_aspect_ratio = 1) {
        this.container = container;
        this.views = views;
        this.ports = [];
        this.view_groups = view_groups;
        this.current_group = 'default';
        this.view_url = view_url;
        this.image_aspect_ratio = image_aspect_ratio;
        this.image_id = null;
        this.image_location = [0, 0];
        this.filters = {
            'contrast': false,
            'invert': false,
            'brightness': 100,
            'saturation': 100,
        },
            // Per-image contrast windowing settings
            this.contrast_windows = {},
            this.standard_layers = [
                [RGBLayer, (view) => view.type == "image"],
                [BingLayer, (view) => view.type == "bingmap"]
            ];
        this.show_controls = false;
        this.show_contrast_windows = false;
    }
    setImage(image_id, image_location) {
        this.clear();
        this.image_id = image_id;
        this.image_location = image_location;
        this.source = {};
    }
    setImageLocation(location) {
        this.image_location = location;

        for (let port of this.ports) {
            port.imageLocationChanged(location);
        }
    }
    showNextGroup() {
        let groups = Object.keys(this.view_groups);
        let index = groups.indexOf(this.current_group);

        if (index >= groups.length - 1) {
            index = 0;
        } else {
            index += 1;
        }

        show_message(`Group: <i>${groups[index]}</i>`);
        this.showGroup(groups[index]);
    }
    showGroup(group = null) {
        if (group === null) {
            group = this.current_group;
        }

        // Save current transformations since we don't want to reset the views
        // just because we chose a new one:
        let canvases = document.getElementsByClassName("view-canvas");
        let transform = null;
        if (canvases.length != 0) {
            transform = canvases[0].getContext("2d").getTransform();
        }

        this.clear();
        this.current_group = group;

        let views = this.getCurrentViews();
        let id = 0;
        for (let view of views) {
            // Safety check to ensure view is defined
            if (!view) {
                console.warn("Undefined view encountered in showGroup");
                continue;
            }

            let view_port = new ViewPort(id, this, view);
            // Add automatically the standard layers if they are applicable:
            for (let standard_layer of this.standard_layers) {
                if (standard_layer[1] === null || standard_layer[1](view)) {
                    view_port.addLayer(
                        new standard_layer[0](view_port, this, view)
                    );
                }
            }
            this.ports.push(view_port);
            id += 1;
        }
        this.updateSize();

        if (transform !== null) {
            for (let canvas of document.getElementsByClassName("view-canvas")) {
                canvas.getContext("2d").setTransform(
                    transform.a,
                    transform.b,
                    transform.c,
                    transform.d,
                    transform.e,
                    transform.f
                );
            }
        }
        this.render();
        this.showControls(this.show_controls);

        vars.config.view_groups = this.view_groups;
        save_config(vars.config);
    }

    calculateViewWidthHeight() {

        let horizontal_spacing = 10;
        let vertical_spacing = 150;

        let allowed_width = round_number(
            (window.innerWidth - horizontal_spacing) / this.getCurrentViews().length
        );
        let allowed_height = window.innerHeight - vertical_spacing;

        let ideal_width = Math.min(
            allowed_width,
            allowed_height * this.image_aspect_ratio,
        );
        let ideal_height = Math.min(
            ideal_width / this.image_aspect_ratio,
            allowed_height
        );

        // if limited horizontally, does not scale
        // if limited vertically, scales DOWN by that factor
        let scale_from_vertical_limit = Math.max(
            1,
            ideal_height / allowed_height
        );

        let width = round_number(ideal_width / scale_from_vertical_limit);
        let height = round_number(width / this.image_aspect_ratio);

        return [width, height];
    }

    updateSize() {
        let [width, height] = this.calculateViewWidthHeight();
        let column = 0;
        for (let view_port of this.ports) {
            view_port.setSize(width, height);
            view_port.setPosition(width * column, 0);
            column += 1;
        }
    }
    clear() {
        let child = this.container.lastElementChild;
        while (child) {
            this.container.removeChild(child);
            child = this.container.lastElementChild;
        }
        this.ports = [];
    }
    addView(name, position = -1) {
        this.view_groups[this.current_group].splice(position, 0, name);
        this.showGroup();
        this.render();
    }
    replaceView(position, name) {
        this.view_groups[this.current_group][position] = name;
        this.showGroup();
        this.render();
    }
    removeView(position) {
        this.view_groups[this.current_group].splice(position, 1);
        this.showGroup();
        this.render();
    }
    getCurrentViews() {
        let views = [];
        for (let view of this.view_groups[this.current_group]) {
            if (this.views.hasOwnProperty(view)) {
                views.push(this.views[view]);
            } else {
                console.warn(`View '${view}' not found in views configuration`);
            }
        }
        return views;
    }
    render(layer = null) {
        for (let view_port of this.ports) {
            view_port.render(layer);
        }
    }
    addStandardLayer(layer_class, condition = null) {
        /*Add a layer which will be automatically added to each new view port

        Args:
            layer_class: Must be a ViewLayer class.
            condition: Can be a function which accepts a view object. If the
                function returns true, the layer will be added to the ViewPort
                holding this view.
        */
        this.standard_layers.push(
            [layer_class, condition]
        );
    }
    getLayers(type = null, exclude = false) {
        let layers = [];
        for (let port of this.ports) {
            for (let layer of port.layers) {
                if (type === null || layer.type == type) {
                    layers.push(layer);
                }
            }
        }
        return layers;
    }

    // Contrast windowing methods
    getContrastWindow(view_name) {
        if (!this.contrast_windows.hasOwnProperty(view_name)) {
            // Initialize with default values
            this.contrast_windows[view_name] = {
                min: 0,
                max: 255,
                histogram: null
            };
        }
        return this.contrast_windows[view_name];
    }

    setContrastWindow(view_name, min, max) {
        this.contrast_windows[view_name] = {
            min: min,
            max: max,
            histogram: this.contrast_windows[view_name]?.histogram || null
        };
        this.render();
    }

    toggleContrastWindows() {
        this.show_contrast_windows = !this.show_contrast_windows;
        for (let port of this.ports) {
            port.toggleContrastWindow();
        }
    }

    showControls(show) {
        let controls = document.getElementsByClassName("view-controls");
        for (let control of controls) {
            if (show) {
                control.style.visibility = "visible";
            } else {
                control.style.visibility = "hidden";
            }
        }
        this.show_controls = show;
    }
    toggleControls() {
        this.showControls(!vars.vm.show_controls);
    }
}

class ViewPort {
    /*The view port element*/
    constructor(id, vm, view) {
        this.id = id;
        this.vm = vm;
        this.view = view;
        this.layers = [];

        this.container = document.createElement('div');
        this.container.style.position = "absolute";
        this.container.style.overflow = "hidden";
        vm.container.appendChild(this.container);

        if (this.view) {
            this.addControls(vm, id, view);
        }
    }
    addControls(vm, id, view) {
        this.controls = document.createElement('div');
        this.controls.classList.add("view-controls");
        this.controls.style.position = "absolute";
        this.controls.style.top = "0px";
        this.controls.style.left = "0px";
        this.controls.style.width = "100%";
        this.controls.style.height = "100%";
        this.controls.style.pointerEvents = "none";
        this.container.appendChild(this.controls);

        this.button_add = document.createElement('button');
        this.button_add.classList.add("view-controls");
        this.button_add.innerHTML = "+";
        this.button_add.style.right = "10px";
        this.button_add.style.top = "10px";
        this.button_add.style.pointerEvents = "auto";
        this.button_add.onclick = () => { vm.addView(view.name, id); };
        this.controls.appendChild(this.button_add);

        // Don't allow user to remove final view from group
        if (vm.getCurrentViews().length > 1) {
            this.button_remove = document.createElement('button');
            this.button_remove.classList.add("view-controls");
            this.button_remove.innerHTML = "-";
            this.button_remove.style.right = "50px";
            this.button_remove.style.top = "10px";
            this.button_remove.style.pointerEvents = "auto";
            this.button_remove.onclick = () => { vm.removeView(id); };
            this.controls.appendChild(this.button_remove);
        } else {
            this.button_remove = null;
        }
        this.select_view = document.createElement('select');
        this.select_view.classList.add("view-controls");
        this.select_view.classList.add("with-arrow");
        this.select_view.innerHTML = "-";
        this.select_view.style.left = "10px";
        this.select_view.style.top = "10px";
        this.select_view.style.width = "130px";
        this.select_view.style.pointerEvents = "auto";
        for (let view_name of Object.keys(vm.views)) {
            var opt = document.createElement("option");
            opt.value = view_name;
            opt.innerHTML = view_name;
            if (view_name == view.name) {
                opt.selected = true;
            }
            this.select_view.appendChild(opt);
        }
        this.select_view.onchange = () => { vm.replaceView(id, this.select_view.value); };
        this.controls.appendChild(this.select_view);

        this.description = document.createElement('p');
        this.description.classList.add("view-controls", "view-description");
        this.description.innerHTML = view.description;
        this.controls.appendChild(this.description);

        // Add contrast windowing controls
        this.addContrastWindowControls();
    }

    addContrastWindowControls() {
        if (!this.view || this.view.type !== "image") return;

        this.contrast_container = document.createElement('div');
        this.contrast_container.classList.add("contrast-window-container");
        this.controls.appendChild(this.contrast_container);

        // minimise button
        this.minimise_button = document.createElement('button');
        this.minimise_button.classList.add("minimise-button");
        this.minimise_btn_icon = document.createElement('img');
        this.minimise_btn_icon.classList.add("minimise-button-icon");
        this.minimise_btn_icon.src = "/segmentation/static/icons/minus.png";
        this.minimise_button.appendChild(this.minimise_btn_icon);
        this.minimise_button.onclick = (e) => {
            e.stopPropagation();
            this.toggleMinimise();
        };
        this.contrast_container.appendChild(this.minimise_button);

        // Histogram canvas
        this.histogram_canvas = document.createElement('canvas');
        this.histogram_canvas.classList.add("histogram-canvas");
        this.contrast_container.appendChild(this.histogram_canvas);

        // Dual range slider container
        this.slider_container = document.createElement('div');
        this.slider_container.classList.add("slider-container");
        this.contrast_container.appendChild(this.slider_container);

        // Create dual range slider
        this.createDualRangeSlider();

        // Initialize as expanded
        this.isMinimised = false;
    }

    toggleMinimise() {
        this.isMinimised = !this.isMinimised;

        if (this.isMinimised) {
            // minimise to small button
            this.contrast_container.classList.add("minimised");

            // Update button
            this.minimise_btn_icon.src = "/segmentation/static/icons/plus.png";
        } else {
            // remove minimised class
            this.contrast_container.classList.remove("minimised");

            // Update button
            this.minimise_btn_icon.src = "/segmentation/static/icons/minus.png";
        }
    }

    createDualRangeSlider() {
        // Create the slider track
        this.slider_track = document.createElement('div');
        this.slider_track.style.position = "absolute";
        this.slider_track.style.width = "100%";
        this.slider_track.style.height = "4px";
        this.slider_track.style.backgroundColor = "#444";
        this.slider_track.style.borderRadius = "2px";
        this.slider_track.style.top = "18px";
        this.slider_container.appendChild(this.slider_track);

        // Create the range fill
        this.range_fill = document.createElement('div');
        this.range_fill.style.position = "absolute";
        this.range_fill.style.height = "4px";
        this.range_fill.style.backgroundColor = "#ff0";
        this.range_fill.style.borderRadius = "2px";
        this.range_fill.style.top = "18px";
        this.range_fill.style.left = "0%";
        this.range_fill.style.width = "100%";
        this.slider_container.appendChild(this.range_fill);

        // Create min slider
        this.min_slider = document.createElement('input');
        this.min_slider.type = "range";
        this.min_slider.min = "0";
        this.min_slider.max = "255";
        this.min_slider.value = "0";
        this.min_slider.style.position = "absolute";
        this.min_slider.style.width = "100%";
        this.min_slider.style.height = "40px";
        this.min_slider.style.top = "0";
        this.min_slider.style.left = "0";
        this.min_slider.style.margin = "0";
        this.min_slider.style.padding = "0";
        this.min_slider.style.backgroundColor = "transparent";
        this.min_slider.style.pointerEvents = "auto";
        this.min_slider.style.zIndex = "1";
        this.min_slider.oninput = () => this.updateDualRangeSlider();
        this.min_slider.onmousedown = (e) => this.handleSliderMouseDown(e, 'min');
        this.slider_container.appendChild(this.min_slider);

        // Create max slider
        this.max_slider = document.createElement('input');
        this.max_slider.type = "range";
        this.max_slider.min = "0";
        this.max_slider.max = "255";
        this.max_slider.value = "255";
        this.max_slider.style.position = "absolute";
        this.max_slider.style.width = "100%";
        this.max_slider.style.height = "40px";
        this.max_slider.style.top = "0";
        this.max_slider.style.left = "0";
        this.max_slider.style.margin = "0";
        this.max_slider.style.padding = "0";
        this.max_slider.style.backgroundColor = "transparent";
        this.max_slider.style.pointerEvents = "auto";
        this.max_slider.style.zIndex = "2";
        this.max_slider.oninput = () => this.updateDualRangeSlider();
        this.max_slider.onmousedown = (e) => this.handleSliderMouseDown(e, 'max');
        this.slider_container.appendChild(this.max_slider);

        // Create value display
        this.value_display = document.createElement('div');
        this.value_display.style.position = "absolute";
        this.value_display.style.top = "25px";
        this.value_display.style.left = "0";
        this.value_display.style.width = "100%";
        this.value_display.style.textAlign = "center";
        this.value_display.style.color = "white";
        this.value_display.style.fontSize = "12px";
        this.value_display.style.fontWeight = "bold";
        this.value_display.innerHTML = "0 - 255";
        this.slider_container.appendChild(this.value_display);

        // Initialize the slider
        this.updateDualRangeSlider();
    }

    handleSliderMouseDown(e, sliderType) {
        // Determine which handle is closer to the click
        const rect = this.slider_container.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickPercent = (clickX / rect.width) * 100;

        const minPercent = (parseInt(this.min_slider.value) / 255) * 100;
        const maxPercent = (parseInt(this.max_slider.value) / 255) * 100;

        // Calculate distance to each handle
        const distanceToMin = Math.abs(clickPercent - minPercent);
        const distanceToMax = Math.abs(clickPercent - maxPercent);

        // Determine which handle to activate
        let targetSlider;
        if (distanceToMin < distanceToMax) {
            targetSlider = 'min';
        } else {
            targetSlider = 'max';
        }

        // If the clicked slider is not the target, temporarily disable it
        if (sliderType !== targetSlider) {
            e.preventDefault();
            e.stopPropagation();

            // Temporarily disable the wrong slider and activate the correct one
            if (targetSlider === 'min') {
                this.min_slider.style.zIndex = "3";
                this.max_slider.style.zIndex = "1";
                this.min_slider.focus();
                this.min_slider.click();
            } else {
                this.max_slider.style.zIndex = "3";
                this.min_slider.style.zIndex = "1";
                this.max_slider.focus();
                this.max_slider.click();
            }
        } else {
            // Correct slider, proceed normally
            if (sliderType === 'min') {
                this.min_slider.style.zIndex = "3";
                this.max_slider.style.zIndex = "1";
            } else {
                this.max_slider.style.zIndex = "3";
                this.min_slider.style.zIndex = "1";
            }
        }
    }

    updateDualRangeSlider() {
        const min = parseInt(this.min_slider.value);
        const max = parseInt(this.max_slider.value);

        // Ensure min doesn't exceed max
        if (min > max) {
            if (this.min_slider === document.activeElement) {
                this.max_slider.value = min;
            } else {
                this.min_slider.value = max;
            }
            return this.updateDualRangeSlider();
        }

        // Update the range fill
        const minPercent = (min / 255) * 100;
        const maxPercent = (max / 255) * 100;

        this.range_fill.style.left = minPercent + "%";
        this.range_fill.style.width = (maxPercent - minPercent) + "%";

        // Update the value display
        this.value_display.innerHTML = min + " - " + max;

        // Update contrast window
        this.vm.setContrastWindow(this.view.name, min, max);
        this.updateHistogram();
    }

    toggleContrastWindow() {
        if (this.contrast_container) {
            this.contrast_container.style.display =
                this.vm.show_contrast_windows ? "block" : "none";
            this.contrast_container.style.visibility =
                this.vm.show_contrast_windows ? "visible" : "hidden";
        }
    }

    updateHistogram() {
        const contrast_window = this.vm.getContrastWindow(this.view.name);
        if (!contrast_window.histogram) return;

        const ctx = this.histogram_canvas.getContext('2d');
        ctx.clearRect(0, 0, this.histogram_canvas.width, this.histogram_canvas.height);

        // Draw histogram
        ctx.fillStyle = '#666';
        ctx.fillRect(0, 0, this.histogram_canvas.width, this.histogram_canvas.height);

        const max_count = Math.max(...contrast_window.histogram);
        const scale = this.histogram_canvas.height / max_count;

        ctx.fillStyle = '#fff';
        for (let i = 0; i < contrast_window.histogram.length; i++) {
            const height = contrast_window.histogram[i] * scale;
            const x = (i / contrast_window.histogram.length) * this.histogram_canvas.width;
            ctx.fillRect(x, this.histogram_canvas.height - height, 1, height);
        }

        // Draw contrast window lines
        const min_x = (contrast_window.min / 255) * this.histogram_canvas.width;
        const max_x = (contrast_window.max / 255) * this.histogram_canvas.width;

        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(min_x, 0);
        ctx.lineTo(min_x, this.histogram_canvas.height);
        ctx.moveTo(max_x, 0);
        ctx.lineTo(max_x, this.histogram_canvas.height);
        ctx.stroke();
    }

    setSize(width, height) {
        this.container.style.width = width.toString() + "px";
        this.container.style.height = height.toString() + "px";
        for (let layer of this.layers) {
            layer.sizeChanged(width, height);
        }
        this.description.style.maxWidth = (width - 40).toString() + "px";
    }
    setPosition(x, y) {
        this.container.style.left = x.toString() + "px";
        this.container.style.top = y.toString() + "px";

        for (let layer of this.layers) {
            layer.positionChanged(x, y);
        }
    }
    addLayer(layer) {
        this.container.appendChild(layer.container);
        this.layers.push(layer);
        layer.container.style.zIndex = this.layers.length;
    }
    render() {
        for (let layer of this.layers) {
            layer.render();
        }
    }
    imageLocationChanged(image_location) {
        for (let layer of this.layers) {
            layer.imageLocationChanged(image_location);
        }
    }
}

class ViewLayer {
    /*Base class for view layers*/
    constructor(port, vm, view, type = "base") {
        this.vm = vm;
        this.port = port;
        this.view = view;
        this.container = null;
        this.type = type
    }

    // empty methods:
    render() {
        /*
        Should be called when transformations inside the canvas happended (such
        as zooming or moving).

        */
    }
    sizeChanged(new_width, new_height) { }
    positionChanged(new_x, new_y) { }
    imageLocationChanged() { }
}

class CanvasLayer extends ViewLayer {
    constructor(port, vm, view, type) {
        super(port, vm, view, type);

        let canvas = document.createElement('canvas');
        canvas.classList.add("view-canvas");

        // Here we set the resolution of the canvas in pixels.
        [canvas.width, canvas.height] = vm.calculateViewWidthHeight();

        // To avoid any blurring of the images or masks, we disable smoothing
        var context = canvas.getContext("2d");
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;
        context.shadowBlur = 0;
        context.shadowColor = null;
        context.imageSmoothingEnabled = false;

        // Track transformations done to the canvas (like zooming and moving)
        trackTransforms(context);

        this.container = canvas;
    }
    sizeChanged(width, height) {
        this.container.style.width = width.toString() + "px";
        this.container.style.height = height.toString() + "px";
    }
}

class RGBLayer extends CanvasLayer {
    constructor(port, vm, view) {
        super(port, vm, view, "rgb");
    }
    loadSource() {
        /*Load an image source if it was not loaded already*/
        if (this.vm.source.hasOwnProperty(this.view.name)) {
            return;
        }

        this.vm.source[this.view.name] = new Image();
        this.vm.source[this.view.name].src =
            this.vm.view_url + this.vm.image_id + "/" + this.view.name;
        // this.image[name].onload = render_image.bind(null, i, true);
    }

    calculateHistogram(imageData) {
        const histogram = new Array(256).fill(0);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            // For RGB images, use average of RGB channels
            const value = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
            histogram[value]++;
        }

        return histogram;
    }

    applyContrastWindow(imageData, min, max) {
        const data = imageData.data;
        const range = max - min;

        for (let i = 0; i < data.length; i += 4) {
            // Apply contrast window to each channel
            for (let j = 0; j < 3; j++) {
                let value = data[i + j];
                value = Math.max(min, Math.min(max, value));
                value = ((value - min) / range) * 255;
                data[i + j] = Math.round(value);
            }
        }

        return imageData;
    }

    render() {
        this.loadSource();

        // Check whether the image has been loaded already
        let image = this.vm.source[this.view.name];
        if (!image.complete) {
            setTimeout(() => { this.render(); }, 100);
            return;
        }

        let canvas = this.container;
        let ctx = canvas.getContext('2d');

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw the original image
        ctx.drawImage(
            image, 0, 0, image.width, image.height
        );

        // Get contrast window settings
        const contrast_window = this.vm.getContrastWindow(this.view.name);

        // Calculate histogram if not already done
        if (!contrast_window.histogram) {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            contrast_window.histogram = this.calculateHistogram(imageData);
            this.vm.contrast_windows[this.view.name] = contrast_window;
        }

        // Apply contrast windowing if enabled
        if (this.vm.show_contrast_windows && (contrast_window.min > 0 || contrast_window.max < 255)) {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const processedData = this.applyContrastWindow(imageData, contrast_window.min, contrast_window.max);
            ctx.putImageData(processedData, 0, 0);
        }

        // Apply CSS filters for brightness, saturation, etc.
        let filters = this.vm.filters;
        if (filters !== null) {
            // Apply brightness, contrast and saturation filters:
            let filter_string = [];
            if (filters.invert) {
                filter_string.push("invert(1)");
            }
            filter_string.push("brightness(" + filters.brightness + "%)");
            filter_string.push("saturate(" + filters.saturation + "%)");
            canvas.style.filter = filter_string.join(" ");
        }

        // Set mask visibility based on current vars.show_mask
        show_mask(vars.show_mask);

        // Update histogram display
        if (this.port && this.port.updateHistogram) {
            this.port.updateHistogram();
        }
    }
}

class BingLayer extends ViewLayer {
    constructor(port, vm, view) {
        super(port, vm, view, "bingmap");

        let iframe = document.createElement('iframe');
        iframe.style.zIndex = 0;
        iframe.frameborder = 1;
        iframe.scrolling = "no";
        this.container = iframe;

        this.update();
    }
    update() {
        // Default location
        let location = this.vm.image_location[0] + "~" + this.vm.image_location[1];

        let url = "https://www.bing.com/maps/embed?";
        // container height and width are given in pixels (e.g. 410px). However,
        // bing only understand pure integers
        url += "h=" + this.container.height.slice(0, -2);
        url += "&w=" + this.container.width.slice(0, -2);
        url += "&cp=" + location;
        url += "&lvl=12&typ=d&sty=a&src=SHELL&FORM=MBEDV8";
        this.container.src = url;
    }
    sizeChanged(width, height) {
        this.container.width = width.toString() + "px";
        this.container.height = height.toString() + "px";
        this.container.style.width = width.toString() + "px";
        this.container.style.height = height.toString() + "px";

        this.update();
    }
    imageLocationChanged(image_location) {
        this.update();
    }
}
