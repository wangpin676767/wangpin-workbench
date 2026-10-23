use std::{env, fs};
fn main() { let a: Vec<_> = env::args().collect(); let data=fs::read(&a[1]).unwrap();fs::write(&a[2],zstd::stream::encode_all(&data[..],3).unwrap()).unwrap(); }
