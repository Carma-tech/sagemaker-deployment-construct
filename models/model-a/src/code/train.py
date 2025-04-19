from botocore.exceptions import SSLError
from botocore.config import Config
from tqdm import tqdm
from datasets import load_dataset
from nltk.util import ngrams as nltk_ngrams
import nltk
import boto3
from model import TextClassificationModel
from torch.utils.data import DataLoader, Dataset, random_split
import torch
import pandas as pd
import tarfile
import time
import logging
import argparse
import sys
import os
from boto3.s3.transfer import TransferConfig


os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

print(boto3.Session().region_name)  # Should match your bucket's region
print(boto3.Session().get_credentials().access_key)  # Should show your key

# Download NLTK data if not present
nltk.download('punkt')

boto_config = Config(
    retries={'max_attempts': 3},
    connect_timeout=120,
    read_timeout=120
)

# Initialize S3 client
s3 = boto3.client('s3', config=boto_config, region_name='us-east-1')


r"""
This file shows the training process of the text classification model with modern libraries
(replacing TorchText with HuggingFace datasets and NLTK).
"""


class TextClassificationDataset(Dataset):
    """Custom Dataset for text classification tasks."""

    def __init__(self, texts, labels, ngram_size=2, vocab=None):
        self.texts = texts
        self.labels = labels
        self.ngram_size = ngram_size
        self.vocab = vocab

    def __len__(self):
        return len(self.texts)

    def __getitem__(self, idx):
        text = self.texts[idx]
        label = self.labels[idx]
        return label, text


def check_s3_file_exists(bucket_name, s3_key):
    """
    Check if a file exists in an S3 bucket.

    :param bucket_name: Name of the S3 bucket.
    :param s3_key: S3 key (path in bucket).
    :return: True if file exists, False otherwise.
    """
    try:
        s3.head_object(Bucket=bucket_name, Key=s3_key)
        return True
    except Exception:
        return False


def save_to_s3(local_path, bucket_name, s3_key):
    """
    Save a local file to an S3 bucket if it doesn't already exist.

    :param local_path: Path to the local file.
    :param bucket_name: Name of the S3 bucket.
    :param s3_key: S3 key (path in bucket).
    """
    # Check if file already exists in S3
    if check_s3_file_exists(bucket_name, s3_key):
        print(f"File already exists in S3: s3://{bucket_name}/{s3_key}")
        return

    if os.path.exists(local_path):
        s3.upload_file(local_path, bucket_name, s3_key)
        print(f"Uploaded {local_path} to s3://{bucket_name}/{s3_key}")
    else:
        print(f"File {local_path} does not exist.")


def split_and_save_data_to_s3(dataset, bucket_name, train_prefix, test_prefix):
    """
    Prepares the dataset for training and testing, and uploads them to S3.

    :param dataset: The HuggingFace DatasetDict with train and test splits.
    :param bucket_name: Name of the S3 bucket.
    :param train_prefix: Prefix for training data in S3.
    :param test_prefix: Prefix for testing data in S3.
    """
    # Get existing train and test splits from dataset dictionary
    train_dataset = dataset['train']
    test_dataset = dataset['test']

    print(f"Training dataset size: {len(train_dataset)}")
    print(f"Testing dataset size: {len(test_dataset)}")

    # Check if files already exist in S3
    train_exists = check_s3_file_exists(bucket_name, train_prefix)
    test_exists = check_s3_file_exists(bucket_name, test_prefix)

    if train_exists and test_exists:
        print("Training and testing datasets already exist in S3, skipping upload")
    else:
        # Convert datasets to Pandas DataFrames
        train_df = pd.DataFrame({
            'label': train_dataset['label'],
            'text': train_dataset['text']
        })

        test_df = pd.DataFrame({
            'label': test_dataset['label'],
            'text': test_dataset['text']
        })

        # Save locally as CSV files
        train_local_path = '/tmp/train.csv'
        test_local_path = '/tmp/test.csv'

        print("Saving training and testing datasets locally...")
        train_df.to_csv(train_local_path, index=False)
        test_df.to_csv(test_local_path, index=False)

        # Upload CSV files to S3
        print("Uploading training and testing datasets to S3...")
        save_to_s3(train_local_path, bucket_name, train_prefix)
        save_to_s3(test_local_path, bucket_name, test_prefix)

    return train_dataset, test_dataset


def create_tar_file(output_filename, files_to_add):
    """
    Create a tar.gz file containing the specified files and directories.

    :param output_filename: Name of the output tar.gz file.
    :param files_to_add: List of file paths to include in the tar.gz file.
    """
    with tarfile.open(output_filename, "w:gz") as tar:
        for file_path in files_to_add:
            if os.path.exists(file_path):
                tar.add(file_path, arcname=os.path.basename(file_path))
                print(f"Added {file_path} to {output_filename}")
            else:
                print(f"File or directory {file_path} does not exist.")


def save_tar_to_s3(local_tar_path, bucket_name, s3_key):
    """
    Upload the tar.gz file to an S3 bucket if it doesn't already exist.

    :param local_tar_path: Path to the local tar.gz file.
    :param bucket_name: Name of the S3 bucket.
    :param s3_key: S3 key (path in bucket).
    """
    config = TransferConfig(
        multipart_threshold=25 * 1024 * 1024,  # 25MB
        multipart_chunksize=25 * 1024 * 1024,
        max_concurrency=10,
        use_threads=True
    )
    # Check if file already exists in S3
    if check_s3_file_exists(bucket_name, s3_key):
        print(
            f"Model archive already exists in S3: s3://{bucket_name}/{s3_key}")
        return

    try:
        if os.path.exists(local_tar_path):
            s3.upload_file(
                local_tar_path, 
                bucket_name, 
                s3_key, 
                Config=config  # Apply multipart settings
            )
            print(f"Uploaded {local_tar_path} to s3://{bucket_name}/{s3_key}")
        else:
            print(f"File {local_tar_path} does not exist.")
        return
    except SSLError as e:
        print(f"SSL Error: {e}")
        raise


def create_ngram_tokens(tokens, n):
    """
    Create n-grams from tokens.

    :param tokens: List of tokens.
    :param n: N-gram size.
    :return: List of n-grams.
    """
    return [' '.join(gram) for gram in nltk_ngrams(tokens, n)]


def build_vocab_from_dataset(dataset, ngram_size):
    """
    Build vocabulary from dataset.

    :param dataset: Dataset containing texts.
    :param ngram_size: Size of n-grams.
    :return: Dictionary mapping tokens to indices.
    """
    print("Building vocabulary...")
    vocab = {'<unk>': 0}
    token_idx = 1

    for item in tqdm(dataset):
        text = item['text']
        # Use simple whitespace tokenization
        tokens = text.split()
        ngram_tokens = create_ngram_tokens(tokens, ngram_size)

        for token in ngram_tokens:
            if token not in vocab:
                vocab[token] = token_idx
                token_idx += 1

    print(f"Vocabulary size: {len(vocab)}")
    return vocab


def text_pipeline(text, ngram_size, vocab):
    """
    Process text into tensor of token indices.

    :param text: Input text.
    :param ngram_size: Size of n-grams.
    :param vocab: Vocabulary mapping.
    :return: List of token indices.
    """
    # Use simple whitespace tokenization
    tokens = text.split()
    ngram_tokens = create_ngram_tokens(tokens, ngram_size)
    return [vocab.get(token, vocab['<unk>']) for token in ngram_tokens]


def collate_batch(batch, ngram_size, vocab, device):
    """
    Collate batch of examples.

    :param batch: Batch of examples.
    :param ngram_size: Size of n-grams.
    :param vocab: Vocabulary mapping.
    :param device: Device to use.
    :return: Batch of tensors.
    """
    label_list, text_list, offsets = [], [], [0]

    for (_label, _text) in batch:
        label_list.append(_label)
        processed_text = torch.tensor(
            text_pipeline(_text, ngram_size, vocab),
            dtype=torch.int64
        )
        text_list.append(processed_text)
        offsets.append(processed_text.size(0))

    label_list = torch.tensor(label_list, dtype=torch.int64)
    offsets = torch.tensor(offsets[:-1]).cumsum(dim=0)
    text_list = torch.cat(text_list)

    return label_list.to(device), text_list.to(device), offsets.to(device)


def train(dataloader, model, optimizer, criterion, epoch):
    """
    Train model for one epoch.

    :param dataloader: DataLoader for training data.
    :param model: Model to train.
    :param optimizer: Optimizer to use.
    :param criterion: Loss function.
    :param epoch: Current epoch number.
    """
    model.train()
    total_acc, total_count = 0, 0
    log_interval = 500

    for idx, (label, text, offsets) in enumerate(dataloader):
        optimizer.zero_grad()
        predicted_label = model(text, offsets)
        loss = criterion(predicted_label, label)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 0.1)
        optimizer.step()
        total_acc += (predicted_label.argmax(1) == label).sum().item()
        total_count += label.size(0)
        if idx % log_interval == 0 and idx > 0:
            print(
                "| epoch {:3d} | {:5d}/{:5d} batches "
                "| accuracy {:8.3f}".format(epoch, idx, len(
                    dataloader), total_acc / total_count)
            )
            total_acc, total_count = 0, 0


def evaluate(dataloader, model):
    """
    Evaluate model on dataloader.

    :param dataloader: DataLoader for evaluation data.
    :param model: Model to evaluate.
    :return: Accuracy.
    """
    model.eval()
    total_acc, total_count = 0, 0

    with torch.no_grad():
        for idx, (label, text, offsets) in enumerate(dataloader):
            predicted_label = model(text, offsets)
            total_acc += (predicted_label.argmax(1) == label).sum().item()
            total_count += label.size(0)

    return total_acc / total_count


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Train a text classification model on text classification datasets.")
    parser.add_argument("--dataset", type=str, default="ag_news",
                        help="Dataset to use for training (default: ag_news)")
    parser.add_argument("--epochs", type=int, default=5,
                        help="num epochs (default=5)")
    parser.add_argument("--embed-dim", type=int, default=32,
                        help="embed dim. (default=32)")
    parser.add_argument("--batch-size", type=int, default=16,
                        help="batch size (default=16)")
    parser.add_argument("--split-ratio", type=float, default=0.95,
                        help="train/valid split ratio (default=0.95)")
    parser.add_argument("--learning-rate", type=float, default=4.0,
                        help="learning rate (default=4.0)")
    parser.add_argument("--lr-gamma", type=float, default=0.8,
                        help="gamma value for lr (default=0.8)")
    parser.add_argument("--ngrams", type=int, default=2,
                        help="ngrams (default=2)")
    parser.add_argument("--num-workers", type=int, default=0,  # Changed to 0 to avoid multiprocessing issues
                        help="num of workers (default=0)")
    parser.add_argument("--device", default="cpu", help="device (default=cpu)")
    parser.add_argument("--data-dir", default=".data",
                        help="data directory (default=.data)")
    parser.add_argument(
        "--use-sp-tokenizer", type=bool, default=False, help="use sentencepiece tokenizer (default=False)"
    )
    # Support both --dictionary and --dictionary_path for backward compatibility
    parser.add_argument("--dictionary", help="path to save vocab")
    parser.add_argument("--dictionary_path", default="/opt/ml/model/vocab.pth")
    parser.add_argument(
        "--save-model-path", default="/opt/ml/model/model.pth", help="path for saving model")
    parser.add_argument("--logging-level", default="WARNING",
                        help="logging level (default=WARNING)")
    # S3 related arguments
    parser.add_argument("--bucket-name", default=os.getenv('BUCKET_NAME', 'sagemaker-deployment-dev-model-artifacts-bucket'),
                        help="Name of the S3 bucket where data and artifacts will be stored.")
    parser.add_argument("--train-prefix", default="models/model-a/training/data/train.csv",
                        help="S3 prefix for training data.")
    parser.add_argument("--test-prefix", default="models/model-a/training/data/test.csv",
                        help="S3 prefix for testing data.")
    parser.add_argument("--artifacts-prefix", default="models/model-a/train-artifacts",
                        help="S3 prefix for saving model artifacts.")
    # Directories for input/output data and model artifacts
    parser.add_argument('--output-data-dir', type=str,
                        default=os.environ.get('SM_OUTPUT_DATA_DIR'))
    parser.add_argument('--model-dir', type=str,
                        default=os.environ.get('SM_MODEL_DIR'))
    parser.add_argument('--train', type=str,
                        default=os.environ.get('SM_CHANNEL_TRAIN'))
    parser.add_argument('--test', type=str,
                        default=os.environ.get('SM_CHANNEL_TEST'))

    args = parser.parse_args()

    # For backwards compatibility, support both uppercase and lowercase dataset names
    if args.dataset == "AG_NEWS":
        args.dataset = "ag_news"

    # For backwards compatibility, if dictionary is provided but dictionary_path is not
    if args.dictionary and not args.dictionary_path:
        args.dictionary_path = args.dictionary

    logging.basicConfig(level=getattr(logging, args.logging_level))

    # Set device
    device = torch.device(args.device)

    # Load dataset using HuggingFace datasets
    print(f"Loading {args.dataset} dataset...")
    try:
        full_dataset = load_dataset(args.dataset)

        # Split data and upload to S3
        train_dataset, test_dataset = split_and_save_data_to_s3(
            full_dataset,
            args.bucket_name,
            args.train_prefix,
            args.test_prefix
        )
    except Exception as e:
        print(f"Error loading dataset: {e}")
        print("Trying to load with 'trust_remote_code=True'...")
        try:
            full_dataset = load_dataset(args.dataset, trust_remote_code=True)

            # Split data and upload to S3
            train_dataset, test_dataset = split_and_save_data_to_s3(
                full_dataset,
                args.bucket_name,
                args.train_prefix,
                args.test_prefix
            )
        except Exception as e2:
            print(f"Still encountered error: {e2}")
            raise

    # Get n-gram size
    ngram_size = args.ngrams

    # Build vocabulary
    vocab = build_vocab_from_dataset(train_dataset, ngram_size)

    # Get number of classes
    num_class = len(set(train_dataset['label']))

    # Create model
    model = TextClassificationModel(
        len(vocab), args.embed_dim, num_class).to(device)

    # Set up optimizer and loss
    criterion = torch.nn.CrossEntropyLoss().to(device)
    optimizer = torch.optim.SGD(model.parameters(), lr=args.learning_rate)
    scheduler = torch.optim.lr_scheduler.StepLR(
        optimizer, 1.0, gamma=args.lr_gamma)

    # Create custom datasets
    train_custom_dataset = TextClassificationDataset(
        train_dataset['text'],
        train_dataset['label'],
        ngram_size,
        vocab
    )

    test_custom_dataset = TextClassificationDataset(
        test_dataset['text'],
        test_dataset['label'],
        ngram_size,
        vocab
    )

    # Split training data for validation
    num_train = int(len(train_custom_dataset) * args.split_ratio)
    split_train_, split_valid_ = random_split(
        train_custom_dataset,
        [num_train, len(train_custom_dataset) - num_train]
    )

    # Create a custom collate function that doesn't rely on closures for pickling compatibility
    def collate_fn(batch):
        return collate_batch(batch, ngram_size, vocab, device)

    # Create data loaders
    batch_size = args.batch_size
    train_dataloader = DataLoader(
        split_train_,
        batch_size=batch_size,
        shuffle=True,
        collate_fn=collate_fn,
        num_workers=0  # Set to 0 to avoid multiprocessing issues
    )

    valid_dataloader = DataLoader(
        split_valid_,
        batch_size=batch_size,
        shuffle=True,
        collate_fn=collate_fn,
        num_workers=0  # Set to 0 to avoid multiprocessing issues
    )

    test_dataloader = DataLoader(
        test_custom_dataset,
        batch_size=batch_size,
        shuffle=True,
        collate_fn=collate_fn,
        num_workers=0  # Set to 0 to avoid multiprocessing issues
    )

    # Training loop
    for epoch in range(1, args.epochs + 1):
        epoch_start_time = time.time()
        train(train_dataloader, model, optimizer, criterion, epoch)
        accu_val = evaluate(valid_dataloader, model)
        scheduler.step()
        print("-" * 59)
        print(
            "| end of epoch {:3d} | time: {:5.2f}s | "
            "valid accuracy {:8.3f} ".format(
                epoch, time.time() - epoch_start_time, accu_val)
        )
        print("-" * 59)

    # Evaluate on test set
    print("Checking the results of test dataset.")
    accu_test = evaluate(test_dataloader, model)
    print("test accuracy {:8.3f}".format(accu_test))

    # Save model and vocabulary
    if args.save_model_path:
        print("Saving model to {}".format(args.save_model_path))
        torch.save(model.to("cpu"), args.save_model_path)

    if args.dictionary_path:
        print("Save vocab to {}".format(args.dictionary_path))
        torch.save(vocab, args.dictionary_path)

    # Paths for model artifacts and code folder
    model_path = args.save_model_path  # Example: "/opt/ml/model/model.pth"
    vocab_path = args.dictionary_path  # Example: "/opt/ml/model/vocab.pth"
    # code_folder = os.path.join(os.getcwd(), "models/model-a/src/code")
    code_folder = os.path.dirname(os.path.abspath(__file__))

    # Ensure all paths exist
    if not os.path.exists(code_folder):
        print(f"Code folder does not exist: {code_folder}")

    # Tar file output path
    tar_output_path = "/tmp/model.tar.gz"

    # Create a tar.gz file containing model.pth, vocab.pth, and the code folder
    create_tar_file(
        tar_output_path,
        [model_path, vocab_path, code_folder]
    )

    # Upload the tar.gz file to S3
    bucket_name = args.bucket_name
    # Example: "models/model-a/train-artifacts/model.tar.gz"
    s3_key = f"{args.artifacts_prefix}/model.tar.gz"

    save_tar_to_s3(tar_output_path, bucket_name, s3_key)
