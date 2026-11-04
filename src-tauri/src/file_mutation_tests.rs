use super::*;
use std::cell::Cell;

fn scratch() -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("purgeon-mutation-{}", broker::random_id().unwrap()));
    fs::create_dir(&path).unwrap();
    // Use the long fixture path so TEMP aliases match the opened handle's resolved path.
    let path = fs::canonicalize(path).unwrap();
    let path = path.to_str().expect("scratch path must be UTF-8");
    PathBuf::from(path.strip_prefix(r"\\?\").unwrap_or(path))
}

#[test]
fn plain_writes_preserve_existing_objects_and_refuse_hardlinks() {
    let root = scratch();
    let target = root.join("nested").join("state.txt");
    let path = target.to_str().unwrap().to_owned();
    write_text(path.clone(), "old".into()).unwrap();
    append_text(path.clone(), "+append".into()).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"old+append");
    write_text(path.clone(), "new".into()).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new");
    let alias = root.join("alias.txt");
    fs::hard_link(&target, &alias).unwrap();
    for append in [false, true] {
        assert!(atomic_file::write_in_place(alias.to_str().unwrap(), b"bad", append).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"new");
    }
    fs::remove_file(alias).unwrap();
    let original_permissions = fs::metadata(&target).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions.clone()).unwrap();
    assert!(write_text(path.clone(), "bad".into()).is_err());
    assert!(append_text(path, "bad".into()).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"new");
    fs::set_permissions(&target, original_permissions).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn erase_uses_opened_length_and_final_cancellation_retains_file() {
    for replacement in [false, true] {
        let root = scratch();
        let target = root.join("erase.bin");
        fs::write(&target, b"x").unwrap();
        let cancelled = Cell::new(false);
        let error = erase_file_with_hooks(
            target.to_str().unwrap().into(),
            vec!["zero".into()],
            || cancelled.get(),
            || {
                if replacement {
                    fs::remove_file(&target).unwrap();
                }
                fs::write(&target, vec![42u8; 4097]).unwrap();
            },
            || cancelled.set(true),
        )
        .unwrap_err();
        assert_eq!(error, "cancelled");
        assert_eq!(fs::read(&target).unwrap(), vec![0u8; 4097]);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn erase_refuses_hardlinks_and_initial_cancellation() {
    let root = scratch();
    let target = root.join("erase.bin");
    let alias = root.join("alias.bin");
    fs::write(&target, b"keep").unwrap();
    fs::hard_link(&target, &alias).unwrap();
    assert!(erase_file_with_hooks(
        alias.to_str().unwrap().into(),
        vec!["zero".into()],
        || false,
        || {},
        || {}
    )
    .is_err());
    assert_eq!(fs::read(&target).unwrap(), b"keep");
    fs::remove_file(&alias).unwrap();
    assert_eq!(
        erase_file_with_hooks(
            target.to_str().unwrap().into(),
            vec!["zero".into()],
            || true,
            || {},
            || {}
        )
        .unwrap_err(),
        "cancelled"
    );
    assert_eq!(fs::read(&target).unwrap(), b"keep");
    fs::remove_dir_all(root).unwrap();
}
