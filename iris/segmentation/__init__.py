from datetime import datetime, timedelta
from glob import glob
import io
import json
import os
from os.path import basename, dirname, exists, join
import time
from pprint import pprint

import lightgbm as lgb
import flask
import numpy as np
import rasterio as rio
from rasterio.io import MemoryFile
from scipy.ndimage import convolve, minimum_filter, maximum_filter
from skimage.io import imread, imsave
from skimage.filters import sobel
from skimage.segmentation import felzenszwalb
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score, jaccard_score
import yaml

from iris.user import requires_auth
from iris.models import db, User, Action
from iris.project import project

segmentation_app = flask.Blueprint(
    'segmentation', __name__,
    template_folder='templates',
    static_folder='static'
)

@segmentation_app.route('/', methods=['GET'])
def index():
    image_id = flask.request.args.get('image_id', None)

    if image_id is None:
        image_id = project.get_start_image_id()

        user_id = flask.session.get('user_id', None)
        if user_id:
            # Get the mask that the user worked on the last time
            last_mask = Action.query \
                .filter_by(user_id=user_id) \
                .order_by(Action.last_modification.desc()) \
                .first()

            if last_mask is not None:
                image_id = last_mask.image_id
    elif image_id not in project.image_ids:
        return flask.make_response('Unknown image id!', 404)

    metadata = project.get_metadata(image_id)
    return flask.render_template(
        'segmentation.html',
        image_id=image_id,
        image_location=metadata.get("location", [0, 0])
    )

@segmentation_app.route('/next_image', methods=['GET'])
@requires_auth
def next_image():
    user = User.query.get(flask.session['user_id'])
    project.set_image_seed(user.image_seed)

    image_id = project.get_next_image(
        flask.request.args.get('image_id', project.get_start_image_id()),
        user
    )

    return flask.redirect(
        flask.url_for('segmentation.index', image_id=image_id)
    )

@segmentation_app.route('/previous_image', methods=['GET'])
@requires_auth
def previous_image():
    user = User.query.get(flask.session['user_id'])
    project.set_image_seed(user.image_seed)

    image_id = project.get_previous_image(
        flask.request.args.get('image_id', project.get_start_image_id())
    )

    return flask.redirect(
        flask.url_for('segmentation.index', image_id=image_id)
    )

def get_mask_filenames(image_id, user_id=None):
    """Get final and user mask filenames."""
    final_mask = join(
        project['path'], 'segmentation', image_id,
        f'{user_id}_final.npy'
    )

    user_mask = join(
        project['path'], 'segmentation', image_id,
        f'{user_id}_user.npy'
    )

    return final_mask, user_mask

def read_masks(image_id, user_id):
    """Read the final and user mask."""
    final_mask_file, user_mask_file = get_mask_filenames(image_id, user_id)

    final_mask = np.load(final_mask_file)
    final_mask = np.argmax(final_mask, axis=-1)
    user_mask = np.load(user_mask_file)
    return final_mask, user_mask

def merge_masks(image_id, complete=False):
    """Combine the final masks of all users to a resulting mask and save it as an image.
    Uses all final user masks, both complete and incomplete.

    Set the 'complete' flag to True to generate a binary encoded npy merged mask file
    using only final user masks that are marked as complete."""

    final_mask_paths = get_mask_filenames(image_id, user_id="*")[0]

    # Select final masks for the given image id
    actions = Action.query.filter_by(image_id=image_id)
    mask_uids = ([str(a.user_id) for a in actions if a.complete] if complete
                 else [str(a.user_id) for a in actions])

    # Return early if there are no masks to merge
    if len(mask_uids) < 1:
        return

    users, final_masks = zip(*[
        [basename(path).split('_')[0], np.argmax(np.load(path), axis=-1)]
        for path in glob(final_mask_paths) if basename(path).split('_')[0] in mask_uids
    ])
    final_masks = np.dstack(final_masks)

    # Time to merge the masks, i.e. we are going to count which class is the
    # most often:

    # Unfortunately, there is no fast standard solution for mode in numpy or
    # scipy (scipy.stats.mode is not optimised for our case):
    classes = dict(enumerate(np.unique(final_masks)))
    class_votes = np.zeros((*final_masks.shape[:-1], len(classes)))
    for u in range(len(users)):
        for i, klass in classes.items():
            # We collect the votes for each class for each pixel.
            # Instead of increasing by 1, we could also use the user's rank or
            # etc. to weight their mask
            class_votes[final_masks[..., u] == klass, i] += 1

    # Create the final mask out of the elements occurring the most often:
    winner_indices = np.argmax(class_votes, axis=-1)

    # Retranslate to original classes (we initialised class_votes not with the
    # original class indices):
    merged_mask = np.vectorize(classes.__getitem__, otypes=[np.uint8])(winner_indices)

    # Update the database for all users
    for u, user_id in enumerate(users):
        user = User.query.get(user_id)
        if user is None:
            continue

        action = Action.query.filter_by(
                user=user, image_id=image_id, type="segmentation"
            ).first()
        if not action:
            action = Action(user=user, image_id=image_id, type="segmentation")

        if len(users) == 2:
            # Just check how much the user agrees with the other one:
            other_user = 0 if u else 1
            action.score = get_score(final_masks[..., other_user].ravel(), final_masks[..., u].ravel())
        else:
            action.score = get_score(merged_mask.ravel(), final_masks[..., u].ravel())

        action.unverified = len(users) <= project['segmentation']['unverified_threshold']

    db.session.commit()

    if complete:
        filename = join(project['path'], 'segmentation', image_id, 'final_combined.npy')
        # Represent each class as one-hot
        merged_mask = encode_mask(
            merged_mask, mode='binary'
        )
    else:
        filename = project['segmentation']['path'].format(id=image_id)
        merged_mask = encode_mask(
            merged_mask, mode=project['segmentation']['mask_encoding']
        )
    os.makedirs(dirname(filename), exist_ok=True)
    if filename.endswith('npy'):
        np.save(filename, merged_mask, allow_pickle=False)
    else:
        imsave(filename, merged_mask, check_contrast=False)

def get_score(mask1, mask2):
    if project['segmentation']['score'] == 'jaccard':
        return round(100 * jaccard_score(mask1, mask2))
    elif project['segmentation']['score'] == 'f1':
        return round(100 * f1_score(mask1, mask2, average='macro'))
    elif project['segmentation']['score'] == 'accuracy':
        return round(100 * accuracy_score(mask1, mask2))

def encode_mask(mask, mode='binary'):
    """Encode the mask to save it on disk.

    Args:
        mask: 2D integer numpy array.
        mode: Defines how to encode the mask.
            * integer: Each class will be represented by an integer (does not
                change the mask).
            * binary: Each class gets its own boolean layer.
            * rgb: Each class will be saved with its original RGB colour.
            * rgba: Each class will be saved with its original RGBA colour.

    Returns:
        Encoded numpy array.
    """
    if mode == 'integer':
        return mask.astype(np.uint8)
    elif mode == 'binary':
        n_last_dimension = len(project['classes'])
    elif mode == 'rgb':
        n_last_dimension = 3
    elif mode == 'rgba':
        n_last_dimension = 4
    else:
        raise ValueError("Unknown encoding mode:", mode)

    encoded_mask = np.empty((*mask.shape, n_last_dimension))
    for c, klass in enumerate(project['classes']):
        if mode == 'binary':
            encoded_mask[..., c] = mask == c
        elif mode == 'rgb':
            encoded_mask[mask == c] = klass['colour'][:3]
        elif mode == 'rgba':
            encoded_mask[mask == c] = klass['colour']

    if mode == 'binary':
        return encoded_mask.astype(bool)

    return encoded_mask.astype(np.uint8)

@segmentation_app.route('/load_mask/<image_id>')
@requires_auth
def load_mask(image_id):
    user_id = flask.session.get('user_id')

    try:
        final_mask, user_mask = read_masks(image_id, user_id)

        data = np.concatenate([final_mask.ravel(), user_mask.ravel()])
        data = np.pad(data, 1, constant_values=(254, 254))

        response = flask.make_response(
            data.astype(np.uint8).tobytes()
        )
        response.headers.set('Content-Type', 'application/octet-stream')
        return response
    except:
        return flask.make_response("No user mask available!", 404)


@segmentation_app.route('/load_combined_mask/<image_id>')
@requires_auth
def load_combined_mask(image_id):

    try:
        combined_mask_file = join(project['path'], 'segmentation', image_id, 'final_combined.npy')
        combined_mask = np.load(combined_mask_file)
        combined_mask = np.argmax(combined_mask, axis=-1)

        data = combined_mask.ravel()
        data = np.pad(data, 1, constant_values=(254, 254))

        response = flask.make_response(
            data.astype(np.uint8).tobytes()
        )
        response.headers.set('Content-Type', 'application/octet-stream')
        return response
    except:
        return flask.make_response("No combined mask available!", 404)


def align_mask_to_input(mask_file, input_file):
    """
    Takes a mask file (user or final) and aligns it's filetype and, if relevant, it's
    geographic metadata to the input file. Currently, only GeoTIFF files have their geographic
    metadata aligned, other file types are just copied, without metadata.

    Args:
        mask_file (str): Path to the mask file.
        input_file (str): Path to the input file.

    Returns:
        file: A file-like object containing the aligned mask data.
        str: The file type of the mask file.
    """

    file_type = os.path.splitext(input_file)[-1].lower()
    if file_type not in ['.tif', '.png', '.jpg', '.jpeg', '.npy']:
        Warning(
            f"Unsupported file type {file_type} for mask file. Downloading current file without alignment."
        )
        # Ensure two values are returned as expected by the caller
        return open(mask_file, 'rb'), file_type

    mask_arr = np.load(mask_file)

    if file_type in ['.tif']:

        # If the mask is a GeoTIFF, we need to align its metadata with the input file

        # 1. Open the mask file to read its metadata
        with rio.open(input_file, 'r') as input_src:
            profile = input_src.profile.copy()
            transform = input_src.transform

        # 2. Calculate mask's geographic extent based on project config
        mask_area = project.config['segmentation']['mask_area'] # [xmin, ymin, xmax, ymax] pixel-space

        # Calculate geographic coordinates from pixel coordinates, and other metadata
        xmin, ymin = transform * (mask_area[0], mask_area[1])
        xmax, ymax = transform * (mask_area[2], mask_area[3])

        width = mask_area[2] - mask_area[0]
        height = mask_area[3] - mask_area[1]
        count = len(project.config['classes'])  # Number of classes in the mask
        dtype = rio.uint8  # Assuming for now the mask is stored as uint8

        # 3. Update the profile with the new geographic extent
        profile.update({
            # This is the way we get the mask's geographic position within the original image's
            "transform": rio.Affine(
                (xmax - xmin) / width, 0, xmin,
                0, (ymax - ymin) / height, ymin
            ),
            "crs": input_src.crs,
            "driver": 'GTiff',
            "count": count,  # Number of bands in the mask
            "height": height,
            "width": width,
            "dtype": dtype,
        })

        # 4. Create an in-memory file to write the aligned mask
        with MemoryFile() as memfile:
            with memfile.open(**profile) as dst:
                # Write each class layer to the raster file
                for i in range(mask_arr.shape[-1]):
                    dst.write_band(i + 1, mask_arr[..., i])

            # Read the in-memory file to return it as a BytesIO stream
            aligned_mask_file = io.BytesIO(memfile.read())

    else:
        # For now, all other types are just copied as numpy arrays
        aligned_mask_file = io.BytesIO()
        np.save(aligned_mask_file, mask_arr, allow_pickle=False)
        aligned_mask_file.seek(0)  # Reset the pointer to the beginning of the file
    return aligned_mask_file, file_type


@segmentation_app.route('/download_final_mask/<image_id>', methods=['GET'])
@requires_auth
def download_final_mask(image_id):
    """Return the user mask file for the given image and user
    for them to download it."""
    user_id = flask.session.get('user_id')

    final_mask_path, user_mask_path = get_mask_filenames(image_id, user_id)

    if not exists(final_mask_path) or not exists(user_mask_path):
        return flask.make_response("No user mask available!", 404)
    input_path = project.get_image_path(image_id)
    if isinstance(input_path, dict):
        # TODO: Handle cases where different inputs have different file types
        input_path = list(input_path.values())[0]

    final_mask_file, ext = align_mask_to_input(final_mask_path, input_path)
    response = flask.send_file(final_mask_file, as_attachment=True, download_name=f'{image_id}_{user_id}_mask{ext}')
    response.headers.set('Content-Type', 'application/octet-stream')

    return response

@segmentation_app.route('/save_mask/<image_id>', methods=['POST'])
@requires_auth
def save_mask(image_id):
    user_id = flask.session.get('user_id')

    print('SAVING BY', user_id)

    t = time.time()
    data = np.frombuffer(flask.request.data, dtype=np.uint8)
    print(f'transfer time: {time.time()-t:.2f}s')

    # We will get an octet stream (uint8) from the website. It contains:
    # 0 to 1: magic start byte 254
    # 1 to mask_length: mask
    # mask_length to 2*mask_length: user mask
    # 2*mask_length + 1: magic end byte 254
    mask_length = \
        project['segmentation']['mask_shape'][0] \
        * project['segmentation']['mask_shape'][1]

    if len(data) != 2*mask_length + 2:
        print('Error: Octet-stream does not have the expected length!')
        print(f'Expected length: {2*mask_length + 2}, received length: {len(data)}')
        return flask.make_response("Mask does not have correct format!", 400)
    elif data[0] != 254 and data[-1] != 254:
        print('Error: Magic numbers are not correct!')
        print(f'Start number: {data[0]}, end number: {data[-1]}')
        return flask.make_response("Transferred data is not correct!", 400)

    # We get the mask in the form HxW where each element is a class id
    final_mask = data[1:mask_length+1]
    final_mask = final_mask.reshape(project['segmentation']['mask_shape'][::-1])

    # The user mask denotes who classified the pixels in the mask:
    #   if true: the user classified the pixel
    #   if false: the AI classified the pixel
    user_mask = data[1+mask_length:-1].astype(bool)
    user_mask = user_mask.reshape(project['segmentation']['mask_shape'][::-1])

    final_mask_file, user_mask_file = get_mask_filenames(image_id, user_id)
    os.makedirs(dirname(final_mask_file), exist_ok=True)

    final_mask = encode_mask(final_mask, mode='binary')

    np.save(final_mask_file, final_mask, allow_pickle=False)
    np.save(user_mask_file, user_mask.astype(bool), allow_pickle=False)

    # Update the database:
    user = User.query.get(user_id)
    action = Action.query\
        .filter_by(user=user, image_id=image_id, type="segmentation")\
        .first()
    if not action:
        action = Action(user=user, image_id=image_id, type="segmentation")
    action.last_modification = datetime.utcnow()
    db.session.add(action)
    db.session.commit()

    merge_masks(image_id)

    # We need this to send a successful response to the client
    return flask.make_response('Masks successfully saved!')

def image_dict_to_array(image_dict):
    if isinstance(image_dict, np.ndarray):
        return image_dict

    return np.dstack(
        [image_dict_to_array(v) for v in image_dict.values()]
    )

@segmentation_app.route('/predict_mask/<image_id>', methods=['POST'])
@requires_auth
def predict_mask(image_id):
    config = project.get_user_config(flask.session['user_id'])
    config = config['segmentation']

    print('Fit options:', config)

    # How to exclude certain bands?
    image_dict = project.get_image(image_id, bands=config['ai_model']['bands'])
    image = image_dict_to_array(image_dict)

    n_channels = image.shape[-1]

    # Select only the masking area:
    mask_area = (
        slice(config['mask_area'][1], config['mask_area'][3]),
        slice(config['mask_area'][0], config['mask_area'][2]),
        slice(None, None, None)
    )
    mask_size = config['mask_shape'][0] * config['mask_shape'][1]
    image = image[mask_area]

    data = json.loads(flask.request.data)
    user_indices = np.array(data['user_pixels'])
    user_labels = np.array(data['user_labels'])

    inputs = [image]
    if config['ai_model']['use_edge_filter']:
        edges = np.dstack([
            sobel(image[..., i])
            for i in range(n_channels)
        ])
        inputs.append(edges)

    if config['ai_model']['use_meshgrid']:
        if config['ai_model']['meshgrid_cells'] == "pixelwise":
            x_size, y_size = image.shape[0], image.shape[1]
        else:
            x_size, y_size = map(int, config['ai_model']['meshgrid_cells'].split('x'))
        y_size = 3
        x = np.repeat(np.arange(x_size), int(image.shape[0]/x_size)+1)
        y = np.repeat(np.arange(y_size), int(image.shape[1]/y_size)+1)
        x_grid, y_grid = np.meshgrid(x[:image.shape[0]], y[:image.shape[1]])
        inputs.append(x_grid[..., np.newaxis])
        inputs.append(y_grid[..., np.newaxis])

    if config['ai_model']['use_superpixels']:
        super_pixels = felzenszwalb(
            image, scale=image.shape[0]/5, sigma=4, min_size=100
        )
        inputs.append(super_pixels)

    inputs = np.dstack(inputs).reshape(mask_size, -1)

    train_indices, val_indices, train_labels, val_labels = train_test_split(
        user_indices, user_labels, stratify=user_labels,
        test_size=0.3, random_state=42
    )

    gbm = lgb.LGBMClassifier(
        num_leaves=config['ai_model']['n_leaves'],
        max_bin=128,
        max_depth=config['ai_model']['max_depth'],
        # min_data_in_leaf=1000,
        # bagging_fraction=0.2,
        # boosting_type='dart',
        tree_learner='data',
        learning_rate=0.05,
        n_estimators=config['ai_model']['n_estimators'],
        n_jobs=10,
    )
    early_stopping = lgb.early_stopping(4, verbose=False)
    gbm.fit(
        inputs[train_indices, :], train_labels,
        eval_set=[(inputs[val_indices, :], val_labels)],
        callbacks=[early_stopping]
    )

    # predict the mask for the whole image:
    predictions = gbm.predict(
        inputs, num_iteration=gbm.best_iteration_
    )
    predictions = predictions.astype(np.uint8)

    # Apply suppression filter:
    if config['ai_model']['suppression_threshold'] != 0:
        other_classes = (predictions != config['ai_model']['suppression_default_class']).astype(int)
        other_classes = other_classes.reshape(*config['mask_shape'])
        window_size = config['ai_model']['suppression_filter_size']
        window = np.ones((window_size, window_size))
        window[window_size//2, window_size//2] = 0
        neighbourhood_ratio = convolve(
            other_classes, window, mode='constant', cval=0.5
        ) / (window_size**2 - 1)
        suppress = 100 * neighbourhood_ratio.ravel() < config['ai_model']['suppression_threshold']
        predictions[suppress] = config['ai_model']['suppression_default_class']

    # Return the results:
    response = flask.make_response(
        predictions.tobytes()
    )
    response.headers.set('Content-Type', 'application/octet-stream')
    return response
